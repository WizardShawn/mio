package io.mio.mobile.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import io.mio.mobile.MainActivity
import io.mio.mobile.R
import io.mio.mobile.audio.ChunkPlayer
import io.mio.mobile.avatar.AvatarAssetCatalog
import io.mio.mobile.camera.CameraSession
import io.mio.mobile.overlay.ChatOverlay
import android.util.Base64
import io.mio.mobile.net.AgentPrefsPayload
import io.mio.mobile.net.AgentStatusPayload
import io.mio.mobile.net.AttachedImageArgs
import io.mio.mobile.net.AvatarOutfitPayload
import io.mio.mobile.net.AvatarTalkingPayload
import io.mio.mobile.net.ChatWarningPayload
import io.mio.mobile.net.GestureEventPayload
import io.mio.mobile.net.GesturePrefsPayload
import io.mio.mobile.net.MioClient
import io.mio.mobile.net.MioClient.Companion.JSON
import io.mio.mobile.net.NotificationSurfacePayload
import io.mio.mobile.net.PerceptionActiveAppArgs
import io.mio.mobile.net.PerceptionRequestFramePayload
import io.mio.mobile.net.PerceptionUploadArgs
import io.mio.mobile.net.ReplyChunkPayload
import io.mio.mobile.screen.ScreenCaptureSession
import io.mio.mobile.secure.MobilePrefs
import io.mio.mobile.secure.PairingPayload
import io.mio.mobile.secure.TokenStore
import io.mio.mobile.stt.SpeechSession
import android.widget.Toast
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.atomic.AtomicInteger

/**
 * Single source of truth for the WS connection's lifetime. Bound by
 * the UI for live state + chat history, but stays alive across UI
 * restarts thanks to `startForeground`.
 *
 * **Why a foreground service and not a Bound-only service?**
 *   Android will reap a backgrounded WS-holding process within seconds
 *   under modern doze rules. The foreground notification is the price
 *   of admission for "stay connected while the user's not looking";
 *   the `dataSync` foregroundServiceType is the API-34 bucket for
 *   "long-running sync to the user's own infrastructure".
 *
 * **Why does the service own the player?**
 *   `chat.replyChunk` events arrive over WS; if the chat Activity is
 *   in the background or torn down, we still want Mio's voice to
 *   come through speakers. Owning playback service-side decouples it
 *   from UI lifecycle.
 */
class MioForegroundService : LifecycleService() {

    enum class ConnState { Unpaired, Connecting, Connected, Disconnected, Failed }

    private val _connState = MutableStateFlow(ConnState.Unpaired)
    val connState: StateFlow<ConnState> = _connState.asStateFlow()

    private val _activePairing = MutableStateFlow<PairingPayload?>(null)
    val activePairing: StateFlow<PairingPayload?> = _activePairing.asStateFlow()

    private var client: MioClient? = null
    private var chunkPlayer: ChunkPlayer? = null

    /**
     * Ring-buffered chat-history projection that the UI observes. We
     * don't persist anything on the phone (Phase M-1 explicit non-
     * goal); on every reconnect the UI calls `chat.getHistory` over
     * the wire to rehydrate.
     */
    private val _chatLog = MutableStateFlow<List<ChatEntry>>(emptyList())
    val chatLog: StateFlow<List<ChatEntry>> = _chatLog.asStateFlow()

    /**
     * M-2.4 — bridge between the WS event stream and the in-app
     * avatar `WebView`. The UI's `AvatarController` subscribes via
     * `LaunchedEffect`; we use a `SharedFlow` (replay = 0,
     * extraBufferCapacity > 0) so the avatar can drop stale signals
     * if a recomposition briefly disconnects.
     *
     * Cached prefs back the `getGesturePrefs` RPC the WebView issues
     * before its `chat.gesture` flow goes hot. We bootstrap them
     * over `gesturePrefs.get` right after `Connected` and refresh
     * them whenever the desktop pushes `avatar.setGesturePrefs`.
     */
    private val _avatarSignals = MutableSharedFlow<AvatarSignal>(extraBufferCapacity = 32)
    val avatarSignals: SharedFlow<AvatarSignal> = _avatarSignals.asSharedFlow()

    private val _gesturePrefs = MutableStateFlow<GesturePrefsPayload?>(null)
    val gesturePrefs: StateFlow<GesturePrefsPayload?> = _gesturePrefs.asStateFlow()

    /**
     * M-2.6 — `chat.showWarning` arrives as a desktop-side push when
     * the agent loop pauses (rate cap / repeated errors). We surface
     * it inside the app as a Snackbar (when [ChatScreen] is on screen)
     * and outside the app as a heads-up notification on a higher-
     * priority channel. The UI subscribes to [warningMessages] in a
     * `LaunchedEffect` and feeds the latest message into Material 3's
     * `SnackbarHostState.showSnackbar`.
     */
    private val _warningMessages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val warningMessages: SharedFlow<String> = _warningMessages.asSharedFlow()

    private val nextWarningId = AtomicInteger(2000)

    /**
     * M-6.3 — de-dupe state for `notification.surface`. The brain may
     * re-fire the same `id` if the phone reconnected between the
     * original emission and the WS resubscribe. Sixteen ids ≈ a full
     * day of hourly-cap alerts, which is well beyond anything we'd
     * actually emit before the 60-second TTL ages them out.
     */
    private val nextSurfaceId = AtomicInteger(3000)
    private val recentSurfaceIds: ArrayDeque<RecentSurfaceId> = ArrayDeque()

    /**
     * M-3.7 — privacy-honest banner ("Mio glanced through the camera")
     * fired the moment we satisfy an agent-driven `perception.request
     * Frame`. Kept separate from [warningMessages] so the chat surface
     * can present it as an unobtrusive, short-duration toast — and so
     * it never leaks into the heads-up notification channel.
     */
    private val _perceptionBanner = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val perceptionBanner: SharedFlow<String> = _perceptionBanner.asSharedFlow()

    /**
     * Issue-5 — single-line caption synced to per-chunk TTS playback.
     *
     * Mio's `chat.replyChunk` events carry one `zhText` segment per
     * Japanese sentence, aligned by the desktop's `replyTts` against
     * the reply. The mobile chat pill subscribes to this flow and
     * shows exactly the line whose audio is playing right now —
     * mirroring the desktop chat pill's sentence-paced reveal instead
     * of dumping the entire translation at once.
     *
     * Lifecycle: cleared on `avatar.setIdle` (reply finished), barge-in,
     * disconnect. Untouched between assistant replies so the last
     * sentence stays visible until the next reply begins.
     */
    private val _currentChunkCaption = MutableStateFlow<String?>(null)
    val currentChunkCaption: StateFlow<String?> = _currentChunkCaption.asStateFlow()

    /**
     * Paces captions when voice replies are muted on this phone. With
     * audio off the chunks arrive back-to-back from the WS in under a
     * second, which would otherwise flash every sentence on the pill
     * before the user could read any of them. We pace the visible
     * caption against each chunk's reported `audioDurationMs` instead
     * (with a 1.8 s fallback when the desktop didn't report one) so a
     * muted phone reads sentence-by-sentence at speaking cadence.
     *
     * Cancelled on barge-in, new user turn, disconnect.
     */
    private var mutedCaptionJob: Job? = null
    private val mutedCaptionLock = Any()

    /**
     * M-10 — background overlay (floating bubble + bottom chat dock).
     * Lifecycle is driven by [MainActivity]: `onStop` calls
     * [showOverlayIfEligible], `onStart` calls [hideOverlay]. Null when
     * the user hasn't enabled the overlay or hasn't granted
     * SYSTEM_ALERT_WINDOW yet.
     */
    private var chatOverlay: ChatOverlay? = null
    private var overlayVisible: Boolean = false

    /**
     * Service-owned [SpeechSession]. The single source of truth for
     * voice-input mode across both the in-app mic button and the
     * floating-bubble mic button — owning it here lets either surface
     * start / stop the same recognizer instead of stranding the bubble
     * with no STT (it has no Compose tree to host one of its own).
     *
     * Built lazily on the first toggle, destroyed in [onDestroy].
     * Rebuilt when the user picks a different STT language in Settings
     * (observed via [observeVoiceLanguage]) — Android's SpeechRecognizer
     * is single-language per instance.
     */
    private var speechSession: SpeechSession? = null
    private var speechSessionLanguage: String? = null

    private val _voiceMode = MutableStateFlow(false)
    val voiceMode: StateFlow<Boolean> = _voiceMode.asStateFlow()

    private val _voicePartial = MutableStateFlow("")
    val voicePartial: StateFlow<String> = _voicePartial.asStateFlow()

    /**
     * Mobile-local agent status. The Agent page reads this — it is
     * derived purely from [MobilePrefs.mobileAgentEnabled] /
     * [MobilePrefs.mobileAgentPaused] and never round-trips through
     * the desktop. Toggling pause / save / etc. on the phone
     * deliberately does not propagate to the desktop autonomous loop
     * (the user manages desktop spend on the desktop UI; mobile
     * controls are a separate surface).
     */
    private val _agentStatus = MutableStateFlow<AgentStatusPayload?>(null)
    val agentStatus: StateFlow<AgentStatusPayload?> = _agentStatus.asStateFlow()

    /**
     * Mirror of the *desktop's* autonomous-loop state, updated only by
     * the `agent.status` event the desktop fires on every transition.
     * Used internally by [autoPauseDesktopLoop] / [autoResumeDesktopLoop]
     * — never displayed in the mobile UI, so the phone's status pill
     * stays independent of the desktop's.
     */
    private val _desktopAgentStatus = MutableStateFlow<AgentStatusPayload?>(null)

    /**
     * True while *we* are the ones holding the desktop loop in
     * `paused` state — toggled in [autoPauseDesktopLoop] /
     * [autoResumeDesktopLoop] off the mobile app's foreground
     * transitions. Tracked so we only auto-resume what we auto-paused
     * (the user's own desktop-side pause stays intact across mobile
     * use), and so a manual toggle on either side clears the flag and
     * stops us from fighting the user.
     *
     * The motivating story: a user who turns the autonomous loop off
     * on the desktop to save API spend doesn't want opening the mobile
     * app — to chat, check the bubble, fix Settings — to silently
     * resume it. While the mobile app is foregrounded we pause the
     * loop; on background we restore the prior state.
     */
    private var pausedByForeground = false

    /**
     * Lazily-created CameraSession bound to the service's
     * LifecycleOwner. Reusing one session across requests means we
     * don't pay the ProcessCameraProvider initialization cost more
     * than once per service start. The session itself doesn't hold
     * the camera between captures — see [CameraSession] for the
     * bind/unbind dance.
     */
    private val cameraSession: CameraSession by lazy {
        CameraSession(applicationContext, this)
    }

    /**
     * M-3.7 rate-limit + dedupe state. `recent` remembers the last few
     * requestIds (with timestamps) so a rapid-fire re-request from a
     * flaky network doesn't double-fire.
     *
     * `perceptionInflight` is keyed by frame kind ("back-cam" /
     * "screen"). Per-kind because a mobile-origin chat turn fires a
     * back-cam request AND a screen request almost together — both
     * must be allowed to run; only a *same-kind* re-request while one
     * is still capturing is dropped.
     *
     * [screenCaptureLock] guards the MediaProjection path against a
     * manual screen-share button tap colliding with an autonomous
     * screen pull (both consume the same projection). Camera and
     * screen are independent surfaces, so we deliberately do NOT
     * cross-serialise them — that was eating most of the desktop's
     * 2-second MOBILE_ORIGIN_PULL_TIMEOUT_MS budget on mobile-origin
     * turns where the brain pulls both legs in parallel.
     */
    private val screenCaptureLock = Mutex()
    private val perceptionInflight = mutableMapOf<String, Job>()
    private val perceptionRecent = ArrayDeque<RecentPerceptionRequest>()

    /**
     * M-5.1 — the live MediaProjection. Owned here so it survives UI
     * restarts (no re-consent on every cold open). It does NOT survive
     * process death — the consent token can't be silently reused, so
     * the user re-grants then. `null` whenever no projection is held.
     */
    private var mediaProjection: MediaProjection? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _screenProjectionAvailable = MutableStateFlow(false)
    val screenProjectionAvailable: StateFlow<Boolean> = _screenProjectionAvailable.asStateFlow()

    /** Lazily-built per-capture screen grabber (see [ScreenCaptureSession]). */
    private val screenCaptureSession: ScreenCaptureSession by lazy {
        ScreenCaptureSession(applicationContext)
    }

    /**
     * Fires when the projection ends — the OS "Stop sharing" chip, a
     * revoke, screen-record conflicts. We drop the held projection and
     * demote the foreground-service type back to data-sync only.
     */
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            Log.d(TAG, "MediaProjection stopped")
            mediaProjection = null
            _screenProjectionAvailable.value = false
            startInForeground(buildNotification(_connState.value))
        }
    }

    inner class LocalBinder : android.os.Binder() {
        val service: MioForegroundService get() = this@MioForegroundService
    }

    private val binder = LocalBinder()

    override fun onBind(intent: Intent): IBinder {
        super.onBind(intent)
        return binder
    }

    private val statusSnapshotReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            // M-6.4 / M-6.5 — a freshly-attached tile or widget asks
            // us to re-emit the current state; honour it without
            // touching the WS layer.
            MioStatusBroadcast.notifyState(
                applicationContext,
                _connState.value,
                isTalking = null,
            )
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        chunkPlayer = ChunkPlayer(applicationContext).apply {
            // Drive the sentence-paced caption: each chunk's `zhText`
            // becomes the visible caption the moment its audio starts.
            onChunkStart = { payload ->
                val text = payload.zhText.takeIf { it.isNotBlank() }
                if (text != null) {
                    _currentChunkCaption.value = text
                }
            }
        }
        startInForeground(buildNotification(ConnState.Unpaired))
        observePairing()
        observeActiveApp()
        observeVoiceLanguage()
        observeAppForegroundForAutoPause()
        registerStatusSnapshotReceiver()
        // Seed the local agent status from MobilePrefs so the page
        // shows the right pill on first open without waiting for any
        // wire round-trip.
        refreshLocalAgentStatus()
    }

    /**
     * Tie the desktop's autonomous loop to mobile foreground state:
     * pause it while the user is actively in the mobile app, resume
     * it when they leave. Only the loops *we* pause are restored —
     * if the user paused or disabled the loop on the desktop UI
     * before opening mobile, we leave that alone.
     *
     * `ProcessLifecycleOwner` is the right granularity here: it fires
     * once per cold-start / app-switch, not per Activity transition,
     * so a quick re-foreground (rotate, intent return) doesn't toggle
     * back-to-back.
     */
    private fun observeAppForegroundForAutoPause() {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                autoPauseDesktopLoop()
            }

            override fun onStop(owner: LifecycleOwner) {
                autoResumeDesktopLoop()
            }
        })
    }

    private fun registerStatusSnapshotReceiver() {
        val filter = IntentFilter(MioStatusBroadcast.ACTION_REQUEST_SNAPSHOT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusSnapshotReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusSnapshotReceiver, filter)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_RECONNECT -> reconnect()
            ACTION_DISCONNECT -> teardownClient()
            else -> reconnect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        teardownClient()
        chunkPlayer?.shutdown()
        chunkPlayer = null
        mediaProjection?.let { runCatching { it.stop() } }
        mediaProjection = null
        runCatching { chatOverlay?.hide() }
        chatOverlay = null
        overlayVisible = false
        runCatching { speechSession?.destroy() }
        speechSession = null
        runCatching { unregisterReceiver(statusSnapshotReceiver) }
        super.onDestroy()
    }

    /** Pair a fresh desktop. Stores the payload and reconnects. */
    fun pair(payload: PairingPayload) {
        TokenStore.get(applicationContext).savePairing(payload)
        _activePairing.value = payload
        reconnect()
    }

    /** Forget the paired desktop and stop the WS connection. */
    fun unpair() {
        TokenStore.get(applicationContext).clear()
        _activePairing.value = null
        teardownClient()
        _connState.value = ConnState.Unpaired
        updateNotification()
        MioStatusBroadcast.notifyState(applicationContext, ConnState.Unpaired, isTalking = false)
    }

    /**
     * True-quit entry point for the top-bar "Quit" button. Unlike
     * [unpair] — which keeps the service alive, just offline — this
     * fully stops the service: drops the WS client and any live
     * MediaProjection, removes the ongoing foreground notification, and
     * calls [stopSelf] so `START_STICKY` does NOT resurrect it.
     *
     * Removing the notification matters because that sticky notification
     * is exactly what stops a swipe-away from being a real exit. The
     * hosting activity finishes itself immediately after this call,
     * releasing the last binding so the OS can reap the process.
     */
    fun shutdown() {
        teardownClient()
        mediaProjection?.let { runCatching { it.stop() } }
        mediaProjection = null
        _screenProjectionAvailable.value = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * UI sends a chat message. Returns immediately; reply streams over
     * events. M-3.6 — pass a base64-encoded image to ship it alongside
     * the prompt as `options.manualImage`; the desktop's chat tool
     * forwards that to Claude as the user-turn image input.
     */
    suspend fun sendChat(text: String, manualImage: AttachedImageArgs? = null): Result<Unit> {
        val c = client ?: return Result.failure(IllegalStateException("not connected"))
        val trimmed = text.trim()
        if (trimmed.isEmpty() && manualImage == null) return Result.success(Unit)
        appendUserTurn(trimmed.ifEmpty { "(image)" })
        // Drop the stale sentence-paced caption so the chat pill doesn't
        // keep Mio's last reply visible while we're waiting on hers to
        // the new turn. The next `chat.replyChunk` will fill it back in.
        cancelMutedCaptionQueue()
        _currentChunkCaption.value = null
        return c.chatSend(trimmed, manualImage)
    }

    /**
     * M-4.4 — voice-mode barge-in. Called the instant the STT layer
     * detects the user has started an utterance; silences Mio's
     * in-flight TTS so she never talks over the user. The next reply's
     * chunks play normally — there is no matching "unduck".
     */
    fun duckTts() {
        chunkPlayer?.stopPlayback()
        cancelMutedCaptionQueue()
        // Barge-in wipes the in-flight reply mid-sentence — clear the
        // single-line caption too so the user isn't left staring at
        // half a translation that no longer matches anything audible.
        _currentChunkCaption.value = null
    }

    /**
     * Return the *mobile-local* agent prefs. The Agent page is
     * intentionally decoupled from the desktop's loop: this read
     * never touches the WS, and edits made through [saveAgentPrefs]
     * stay on the phone. Fields the mobile UI doesn't expose
     * (`dailyCostCapUsd` &c.) are filled with zero defaults — they
     * exist only because [AgentPrefsPayload] is a shared shape.
     */
    suspend fun fetchAgentPrefs(): AgentPrefsPayload? {
        val mp = MobilePrefs.get(applicationContext)
        return AgentPrefsPayload(
            enabled = mp.mobileAgentEnabled.value,
            intervalMinutes = mp.mobileAgentIntervalMinutes.value,
            dailyCostCapUsd = 0.0,
            hourlyCycleCap = 0,
            hourlyNotifyCap = 0,
            notableCheckInChat = false,
            perceptionMode = null,
        )
    }

    suspend fun saveAgentPrefs(prefs: AgentPrefsPayload): AgentPrefsPayload? {
        val mp = MobilePrefs.get(applicationContext)
        mp.setMobileAgentEnabled(prefs.enabled)
        mp.setMobileAgentIntervalMinutes(prefs.intervalMinutes)
        refreshLocalAgentStatus()
        return prefs
    }

    suspend fun runAgentNow(): Boolean {
        // Local-only surface: there's no actual loop on the phone to
        // kick. Returning success keeps the UI responsive while the
        // operator's desktop loop stays untouched.
        return true
    }

    suspend fun toggleAgentPause(): AgentStatusPayload? {
        val mp = MobilePrefs.get(applicationContext)
        mp.setMobileAgentPaused(!mp.mobileAgentPaused.value)
        refreshLocalAgentStatus()
        return _agentStatus.value
    }

    /**
     * Recompute the mobile-local agent status pill from
     * [MobilePrefs.mobileAgentEnabled] + [MobilePrefs.mobileAgentPaused].
     * Called on every mutation through the Agent page so the UI
     * picks up the change without a re-fetch.
     */
    private fun refreshLocalAgentStatus() {
        val mp = MobilePrefs.get(applicationContext)
        val state = when {
            !mp.mobileAgentEnabled.value -> "disabled"
            mp.mobileAgentPaused.value -> "paused"
            else -> "idle"
        }
        _agentStatus.value = AgentStatusPayload(state = state)
    }

    /**
     * Pause the desktop autonomous loop on mobile-foreground entry,
     * but only if it isn't *already* in a not-running state — the
     * user's manual desktop-side pause / disable must survive. We
     * remember that *we* were the one who paused via
     * [pausedByForeground] so [autoResumeDesktopLoop] knows whether
     * to restore.
     */
    private fun autoPauseDesktopLoop() {
        if (pausedByForeground) return
        val c = client ?: return
        if (_connState.value != ConnState.Connected) return
        // Only act when we know the *desktop's* current state. If it
        // hasn't hydrated yet (cold open, page not visited), bail —
        // better to leave the loop running for a moment than to flip
        // it blind and end up unpausing a manually-paused loop.
        val state = _desktopAgentStatus.value?.state ?: return
        if (state != "running" && state != "idle") return
        lifecycleScope.launch {
            c.agentPauseToggle()
                .onSuccess { fresh ->
                    if (fresh.state == "paused") {
                        pausedByForeground = true
                        _desktopAgentStatus.value = fresh
                    }
                }
                .onFailure { Log.w(TAG, "auto-pause desktop loop failed: ${it.message}") }
        }
    }

    /**
     * Resume the desktop autonomous loop on mobile-background exit,
     * but only if [autoPauseDesktopLoop] is what paused it. Any other
     * pause source (the user, a desktop-side rate cap) is left alone.
     */
    private fun autoResumeDesktopLoop() {
        if (!pausedByForeground) return
        val c = client
        // Clear unconditionally — we don't want a missed restore (WS
        // briefly down) to leave the flag set and re-fire next time.
        pausedByForeground = false
        if (c == null || _connState.value != ConnState.Connected) return
        lifecycleScope.launch {
            c.agentPauseToggle()
                .onSuccess { fresh -> _desktopAgentStatus.value = fresh }
                .onFailure { Log.w(TAG, "auto-resume desktop loop failed: ${it.message}") }
        }
    }

    /**
     * Toggle voice-input mode. Single source of truth used by both the
     * in-app mic button and the floating-bubble mic button.
     *
     * Returns:
     *  - `Result.success(true)`  — voice mode just turned ON
     *  - `Result.success(false)` — voice mode just turned OFF
     *  - `Result.failure(SecurityException)` — RECORD_AUDIO not granted;
     *    caller decides UX (in-app: launch runtime grant; overlay: toast).
     *  - `Result.failure(IllegalStateException)` — recognizer unavailable
     *    on this device.
     *
     * Must be called on the main thread (SpeechSession enforces this).
     */
    fun toggleVoiceMode(): Result<Boolean> {
        if (_voiceMode.value) {
            speechSession?.stop()
            _voiceMode.value = false
            _voicePartial.value = ""
            // Drop the `microphone` FGS type now that we're done with
            // the mic — leaving it claimed across idle stretches would
            // mislead the user's "what's using the mic" indicators.
            startInForeground(buildNotification(_connState.value), includeMicrophone = false)
            return Result.success(false)
        }
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            return Result.failure(SecurityException("RECORD_AUDIO not granted"))
        }
        val session = ensureSpeechSession()
        if (!session.isAvailable) {
            return Result.failure(IllegalStateException("recognizer unavailable"))
        }
        _voicePartial.value = ""
        _voiceMode.value = true
        // Promote the FGS to claim the `microphone` type BEFORE the
        // recognizer starts capturing. Android 14+ silently denies
        // mic data to a background-Activity caller unless an FGS in
        // its process claims this type — which is why bubble-mode
        // STT was returning empty results while in-app STT (which
        // rides MainActivity's own foreground state) worked fine.
        startInForeground(buildNotification(_connState.value), includeMicrophone = true)
        session.start()
        return Result.success(true)
    }

    private fun ensureSpeechSession(): SpeechSession {
        val lang = MobilePrefs.get(applicationContext).voiceLanguage.value
        val existing = speechSession
        if (existing != null && speechSessionLanguage == lang) return existing
        existing?.destroy()
        val fresh = SpeechSession(applicationContext, lang).also { wireSpeechSession(it) }
        speechSession = fresh
        speechSessionLanguage = lang
        return fresh
    }

    private fun wireSpeechSession(session: SpeechSession) {
        session.onTranscript = { text -> _voicePartial.value = text }
        session.onAutoSend = { text ->
            lifecycleScope.launch {
                sendChat(text).onFailure { Log.w(TAG, "voice auto-send failed: ${it.message}") }
            }
        }
        session.onSpeechStart = { duckTts() }
        session.onFatal = { message ->
            _voiceMode.value = false
            _voicePartial.value = ""
            // Same FGS demotion path as the clean stop — without it
            // the service would keep claiming the `microphone` type
            // after the recognizer has already given up.
            startInForeground(buildNotification(_connState.value), includeMicrophone = false)
            Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Reacts to user-driven changes of [MobilePrefs.voiceLanguage] —
     * Android's `SpeechRecognizer` is single-language per instance, so
     * a language switch has to rebuild the session. We `drop(1)` the
     * initial replay so the first-collection emission doesn't tear
     * down a session that hasn't been built yet anyway.
     */
    private fun observeVoiceLanguage() {
        lifecycleScope.launch {
            MobilePrefs.get(applicationContext)
                .voiceLanguage
                .drop(1) // StateFlow dedupes already; skip the replay emission.
                .collect { _ ->
                    val wasActive = _voiceMode.value
                    speechSession?.stop()
                    speechSession?.destroy()
                    speechSession = null
                    speechSessionLanguage = null
                    if (wasActive) {
                        _voiceMode.value = false
                        _voicePartial.value = ""
                    }
                }
        }
    }

    private fun observePairing() {
        // Hydrate from persistent storage on cold start.
        val stored = TokenStore.get(applicationContext).loadPairing()
        if (stored != null) {
            _activePairing.value = stored
        } else {
            _connState.value = ConnState.Unpaired
            updateNotification()
        }
    }

    /**
     * M-5.4 — forward foreground-app samples from
     * [MioAccessibilityService] (via [ActiveAppRelay]) to the desktop
     * as `perception.activeApp`, but only while a desktop is actually
     * connected. The collector runs for the service's whole lifetime.
     */
    private fun observeActiveApp() {
        lifecycleScope.launch {
            ActiveAppRelay.samples.collect { sample ->
                val c = client
                if (c == null || _connState.value != ConnState.Connected) return@collect
                c.perceptionActiveApp(
                    PerceptionActiveAppArgs(
                        packageName = sample.packageName,
                        activityLabel = sample.activityLabel,
                        ts = sample.ts,
                    ),
                ).onFailure { Log.w(TAG, "perception.activeApp failed: ${it.message}") }
            }
        }
    }

    private fun reconnect() {
        teardownClient()
        val payload = _activePairing.value ?: TokenStore.get(applicationContext).loadPairing()
        if (payload == null) {
            _connState.value = ConnState.Unpaired
            updateNotification()
            MioStatusBroadcast.notifyState(applicationContext, ConnState.Unpaired, isTalking = false)
            return
        }
        _activePairing.value = payload

        val c = MioClient(payload)
        client = c

        lifecycleScope.launch {
            c.state.collect { mapped ->
                val next = when (mapped) {
                    MioClient.State.Idle -> ConnState.Disconnected
                    MioClient.State.Connecting -> ConnState.Connecting
                    MioClient.State.Connected -> ConnState.Connected
                    MioClient.State.Disconnected -> ConnState.Disconnected
                    MioClient.State.Failed -> ConnState.Failed
                }
                val transitionedToConnected = _connState.value != ConnState.Connected && next == ConnState.Connected
                _connState.value = next
                updateNotification()
                // M-6.4 / M-6.5 — fan out connection state to the
                // Quick Settings tile and the home/lock-screen widget.
                // We don't snapshot the talking-vs-idle flag here
                // because `avatar.setTalking` / `avatar.setIdle` push
                // their own broadcasts; the receivers fold both
                // streams independently.
                MioStatusBroadcast.notifyState(applicationContext, next, isTalking = null)
                if (transitionedToConnected) {
                    // M-2.4 bootstrap: read gesture prefs once the
                    // welcome handshake completes. We swallow the
                    // failure path — the bridge's default permissive
                    // prefs keep the avatar interactive until the
                    // desktop sends a fresh push.
                    lifecycleScope.launch { bootstrapGesturePrefs(c) }
                    // Hydrate the desktop loop's status so
                    // [autoPauseDesktopLoop] can act on it — without
                    // this, a cold-start of the mobile app would race
                    // the WS handshake and miss the chance to pause
                    // the loop on this first foreground entry. We
                    // store into the desktop-mirror flow; the
                    // mobile-facing [_agentStatus] stays local-only.
                    lifecycleScope.launch {
                        c.agentStatusGet().onSuccess { status ->
                            _desktopAgentStatus.value = status
                            // Foreground may already have fired before
                            // status hydrated; retry the pause now
                            // that we know whether the loop is hot.
                            val fg = ProcessLifecycleOwner.get().lifecycle.currentState
                            if (fg.isAtLeast(Lifecycle.State.STARTED)) {
                                autoPauseDesktopLoop()
                            }
                        }
                    }
                }
            }
        }
        lifecycleScope.launch { c.events.collect { onServerEvent(payload, it) } }
        lifecycleScope.launch {
            c.failures.collect { reason ->
                Log.w(TAG, "ws failure: $reason")
            }
        }

        c.connect()
    }

    private fun teardownClient() {
        client?.disconnect()
        client = null
        chunkPlayer?.reset()
    }

    private fun onServerEvent(payload: PairingPayload, frame: io.mio.mobile.net.EventFrame) {
        // Issue-2 — mobile-side gate for proactive/cycle replies. Events
        // with `origin = "mobile"` are always processed (the user just
        // sent the turn from this phone). Events with no origin
        // (autonomous cycle, greeting, notable check-in) are gated by
        // the user's mobile preference so a phone left on the desk
        // doesn't keep narrating from the desktop's agent loop unless
        // the user opts in.
        if (frame.origin == null && shouldGateProactive(frame.event)) {
            val prefs = MobilePrefs.get(applicationContext)
            if (!prefs.receiveProactiveReplies.value) {
                return
            }
        }
        when (frame.event) {
            "chat.stream" -> {
                val ev = runCatching {
                    JSON.decodeFromJsonElement(io.mio.mobile.net.ChatStreamEvent.serializer(), frame.payload)
                }.getOrNull() ?: return
                appendStreamDelta(ev)
            }
            "chat.replyChunk" -> {
                val chunk = runCatching {
                    JSON.decodeFromJsonElement(ReplyChunkPayload.serializer(), frame.payload)
                }.getOrNull() ?: return
                val absoluteUrl = chunk.audioUrl?.let { rewriteAssetUrl(payload, it) }
                val voiceOn = MobilePrefs.get(applicationContext).voiceRepliesEnabled.value
                if (voiceOn && absoluteUrl != null) {
                    chunkPlayer?.enqueue(chunk.copy(audioUrl = absoluteUrl))
                } else {
                    // Voice replies muted (or the desktop produced no
                    // audio at all) — pace the caption ourselves at
                    // roughly speaking cadence so the user can read
                    // along instead of having every sentence flash
                    // past on the pill in under a second.
                    enqueueMutedCaption(chunk)
                }
            }
            "chat.replyCaption" -> {
                val caption = runCatching {
                    JSON.decodeFromJsonElement(io.mio.mobile.net.ReplyCaptionPayload.serializer(), frame.payload)
                }.getOrNull() ?: return
                attachCaption(caption.text)
            }
            "avatar.setTalking" -> {
                // Best-effort decode; `mood` may be `null` on the wire.
                val ev = runCatching {
                    JSON.decodeFromJsonElement(AvatarTalkingPayload.serializer(), frame.payload)
                }.getOrNull()
                tryEmitAvatarSignal(AvatarSignal.Talking(mood = ev?.mood))
                // M-6.5 — let the home-screen widget switch its state
                // pill to "talking" without having to re-read the
                // service state on every tick.
                MioStatusBroadcast.notifyState(applicationContext, _connState.value, isTalking = true)
            }
            "avatar.setIdle" -> {
                tryEmitAvatarSignal(AvatarSignal.Idle)
                MioStatusBroadcast.notifyState(applicationContext, _connState.value, isTalking = false)
                // Reply finished — leave the last sentence visible on
                // the pill (so the user can still finish reading) but
                // mark the reply as no longer in flight so a fresh user
                // turn can clear it.
            }
            "avatar.setGesturePrefs" -> {
                val prefs = runCatching {
                    JSON.decodeFromJsonElement(GesturePrefsPayload.serializer(), frame.payload)
                }.getOrNull() ?: return
                _gesturePrefs.value = prefs
                tryEmitAvatarSignal(AvatarSignal.Prefs(prefs))
            }
            "avatar.setOutfit" -> {
                val ev = runCatching {
                    JSON.decodeFromJsonElement(AvatarOutfitPayload.serializer(), frame.payload)
                }.getOrNull() ?: return
                // Substitute the WS-rewritten desktop URL with the
                // bundled APK copy of the same outfit (matched by
                // id). Two reasons:
                //   1) The avatar page is loaded from the
                //      `appassets.androidplatform.net` virtual https
                //      origin. Three.js `fetch()` on the desktop's
                //      plain-`http://<host>/asset/...` URL would be
                //      mixed-content blocked by the WebView.
                //   2) The mobile bundle already ships the same VRM
                //      files; loading them locally is instant.
                // When the phone is missing the file (manifest drift),
                // fall back to the desktop URL — three.js will then
                // surface a fetch error in the bundle's logs which is
                // easier to diagnose than a silent no-op.
                val local = AvatarAssetCatalog(applicationContext)
                    .resolveOutfitUrl(ev.outfitId)
                val resolvedPath = local ?: ev.vrmPath
                tryEmitAvatarSignal(
                    AvatarSignal.Outfit(
                        AvatarOutfitPayload(
                            outfitId = ev.outfitId,
                            label = ev.label,
                            vrmPath = resolvedPath,
                        ),
                    ),
                )
            }
            "chat.showWarning" -> {
                val warning = runCatching {
                    JSON.decodeFromJsonElement(ChatWarningPayload.serializer(), frame.payload)
                }.getOrNull() ?: return
                if (warning.message.isBlank()) return
                handleChatWarning(warning.message)
            }
            "perception.requestFrame" -> {
                val req = runCatching {
                    JSON.decodeFromJsonElement(
                        PerceptionRequestFramePayload.serializer(),
                        frame.payload,
                    )
                }.getOrNull() ?: return
                handlePerceptionRequest(req)
            }
            "notification.surface" -> {
                val surfacePayload = runCatching {
                    JSON.decodeFromJsonElement(
                        NotificationSurfacePayload.serializer(),
                        frame.payload,
                    )
                }.getOrNull() ?: return
                handleSurfaceNotification(surfacePayload)
            }
            "agent.status" -> {
                val status = runCatching {
                    JSON.decodeFromJsonElement(
                        AgentStatusPayload.serializer(),
                        frame.payload,
                    )
                }.getOrNull() ?: return
                // The mobile UI's pill is local-derived now; this WS
                // signal feeds only the desktop-mirror used by the
                // auto-pause logic.
                _desktopAgentStatus.value = status
            }
            else -> {
                // Phase M-1 ignored avatar.*, agent.*; M-2 wires the
                // avatar subset, chat.showWarning, and surfaces
                // captions/chunks. The remaining `agent.*` family
                // lands in M-4.
            }
        }
    }

    /**
     * M-2.6 routing:
     *  - Always emit on [warningMessages] so a foreground `ChatScreen`
     *    can pop a Snackbar inline. The Compose collector is lenient
     *    about drops (extraBufferCapacity = 8), so a flurry of
     *    warnings while the UI is briefly recomposing won't strand
     *    one in a queue forever.
     *  - When the UI process is not foreground, also fire a heads-up
     *    notification on a separate, higher-priority channel so the
     *    user notices.
     */
    /**
     * M-6.3 — `notification.surface` heads-up dispatch. Unlike
     * `chat.showWarning` we ALWAYS render this as a notification (even
     * when the chat surface is foreground) because the desktop OS
     * toast already covered the local user; if we suppressed the
     * phone heads-up while the app is open the user could still miss
     * the alert by tabbing away one second later. The dedicated
     * `mio.surface.v1` channel keeps it muteable independently of the
     * agent-alerts channel.
     */
    private fun handleSurfaceNotification(payload: NotificationSurfacePayload) {
        if (payload.title.isBlank() && payload.body.isBlank()) return
        pruneSurfaceIds(System.currentTimeMillis())
        val id = payload.id
        if (id != null && recentSurfaceIds.any { it.id == id }) {
            Log.d(TAG, "notification.surface duplicate id=$id within TTL — ignoring")
            return
        }
        if (id != null) {
            recentSurfaceIds.addLast(RecentSurfaceId(id, System.currentTimeMillis()))
        }
        postSurfaceNotification(payload)
    }

    private fun postSurfaceNotification(payload: NotificationSurfacePayload) {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            2,
            tapIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = payload.title.ifBlank { getString(R.string.app_name) }
        val body = payload.body
        val priority = when (payload.priority) {
            "high" -> NotificationCompat.PRIORITY_HIGH
            else -> NotificationCompat.PRIORITY_DEFAULT
        }
        val notif = NotificationCompat.Builder(this, SURFACE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(priority)
            .build()
        mgr.notify(nextSurfaceId.getAndIncrement(), notif)
    }

    private fun pruneSurfaceIds(nowMs: Long) {
        while (recentSurfaceIds.isNotEmpty() &&
            nowMs - recentSurfaceIds.first().tsMs > SURFACE_DEDUPE_TTL_MS
        ) {
            recentSurfaceIds.removeFirst()
        }
    }

    private data class RecentSurfaceId(val id: String, val tsMs: Long)

    private fun handleChatWarning(message: String) {
        _chatLog.value = _chatLog.value + ChatEntry.System(text = "⚠ $message")
        if (!_warningMessages.tryEmit(message)) {
            Log.w(TAG, "warning buffer full; Snackbar may miss: $message")
        }
        val state = ProcessLifecycleOwner.get().lifecycle.currentState
        if (!state.isAtLeast(Lifecycle.State.STARTED)) {
            postWarningNotification(message)
        }
    }

    /**
     * M-5.1 — promote the foreground service to include the
     * `mediaProjection` type, then acquire the `MediaProjection` from
     * the consent result `MainActivity` captured. On Android 14 the
     * FGS type MUST be set before `getMediaProjection` is called, so
     * the promotion happens first. Called once per consent grant.
     */
    fun startMediaProjection(resultCode: Int, data: Intent) {
        startInForeground(buildNotification(_connState.value), includeProjection = true)
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val projection = runCatching { mgr.getMediaProjection(resultCode, data) }
            .onFailure { Log.w(TAG, "getMediaProjection failed: ${it.message}") }
            .getOrNull()
        if (projection == null) {
            startInForeground(buildNotification(_connState.value))
            return
        }
        projection.registerCallback(projectionCallback, mainHandler)
        mediaProjection = projection
        _screenProjectionAvailable.value = true
        Log.d(TAG, "MediaProjection acquired")
    }

    /** Tear down the projection — used by an explicit "stop sharing". */
    fun stopMediaProjection() {
        mediaProjection?.let { runCatching { it.stop() } }
        mediaProjection = null
        _screenProjectionAvailable.value = false
        startInForeground(buildNotification(_connState.value))
    }

    /**
     * M-5.3 — one-shot manual screen capture for the bottom-row screen
     * button. Returns null when no projection is held or the capture
     * failed. Unlike the agent-driven path this does NOT upload — the
     * caller attaches the frame as `ChatSendOptions.manualImage`. Held
     * under [screenCaptureLock] so it serialises against an in-flight
     * agent-driven screen pull on the same MediaProjection.
     */
    suspend fun captureScreenFrame(): ScreenCaptureSession.ScreenFrame? {
        val projection = mediaProjection ?: return null
        return screenCaptureLock.withLock {
            runCatching { screenCaptureSession.capture(projection) }
                .onFailure { Log.w(TAG, "manual screen capture failed: ${it.message}") }
                .getOrNull()
        }
    }

    /**
     * M-3.7 / M-5.3 — agent-driven perception pull. The desktop emits
     * `perception.requestFrame` when the brain wants a fresh view; we
     * capture, encode, and upload via [`MioClient.perceptionUpload`].
     * `back-cam` / `front-cam` go through CameraX; `screen` goes
     * through MediaProjection.
     */
    private fun handlePerceptionRequest(req: PerceptionRequestFramePayload) {
        when (req.kind) {
            "back-cam", "front-cam" -> handleCameraPerceptionRequest(req)
            "screen" -> handleScreenPerceptionRequest(req)
            else -> Log.d(TAG, "perception.requestFrame kind=${req.kind} unsupported — ignoring")
        }
    }

    /**
     * Camera pull. Dropped silently when CAMERA isn't granted or the
     * WS is down — the agent loop then degrades to the desktop
     * screenshot.
     */
    private fun handleCameraPerceptionRequest(req: PerceptionRequestFramePayload) {
        val facing = when (req.kind) {
            "back-cam" -> CameraSession.Facing.Back
            "front-cam" -> CameraSession.Facing.Front
            else -> return
        }
        // Issue-2 (follow-up) — mobile-side gate: when the user has
        // flipped the "Auto camera" toggle off they want the desktop's
        // implicit-perception pulls (typed turn, agent cycle, avatar
        // touch) to never glance through the camera. Drop the request
        // silently — the desktop's perception step then falls back to
        // its own monitor screenshot (or no image, per AgentPerceptionMode).
        if (!MobilePrefs.get(applicationContext).cameraAutoEnabled.value) {
            Log.d(TAG, "perception.requestFrame ignored: cameraAutoEnabled = false")
            return
        }
        val hasCamera = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasCamera) {
            Log.d(TAG, "perception.requestFrame ignored: CAMERA permission not granted")
            return
        }
        val c = client
        if (c == null || _connState.value != ConnState.Connected) {
            Log.d(TAG, "perception.requestFrame ignored: WS not connected")
            return
        }
        if (!claimPerceptionSlot(req)) return
        perceptionInflight[req.kind] = lifecycleScope.launch {
            runPerceptionCapture(c, req, facing)
        }
    }

    /**
     * M-5.3 — screen pull. Needs a live MediaProjection (the user
     * grants it once via the screen-capture button); dropped silently
     * when there's none, mirroring the camera path's "no permission →
     * degrade to the desktop screenshot".
     */
    private fun handleScreenPerceptionRequest(req: PerceptionRequestFramePayload) {
        // Mirror of the camera gate above for the screen-projection
        // path. Off → silently drop the request and let the desktop
        // fall back to its own monitor screenshot.
        if (!MobilePrefs.get(applicationContext).screenAutoEnabled.value) {
            Log.d(TAG, "perception.requestFrame screen ignored: screenAutoEnabled = false")
            return
        }
        val projection = mediaProjection
        if (projection == null) {
            Log.d(TAG, "perception.requestFrame screen ignored: no MediaProjection")
            // The user has the auto-screen toggle ON but no live
            // projection — most likely they granted once, the OS killed
            // it (background, conflict), and now there's nothing to
            // capture. Surface this rather than silently dropping.
            _perceptionBanner.tryEmit(getString(R.string.perception_banner_screen_needs_grant))
            return
        }
        val c = client
        if (c == null || _connState.value != ConnState.Connected) {
            Log.d(TAG, "perception.requestFrame screen ignored: WS not connected")
            return
        }
        if (!claimPerceptionSlot(req)) return
        perceptionInflight[req.kind] = lifecycleScope.launch {
            screenCaptureLock.withLock {
                runScreenPerceptionCapture(c, req, projection)
            }
        }
    }

    /**
     * Dedupe + single-in-flight gate shared by the camera and screen
     * pull paths. Synchronous — all WS events arrive on the one
     * events-collector coroutine. Returns true when the caller may
     * proceed with a capture.
     */
    private fun claimPerceptionSlot(req: PerceptionRequestFramePayload): Boolean {
        val now = System.currentTimeMillis()
        pruneRecentPerception(now)
        if (perceptionRecent.any { it.requestId == req.requestId }) {
            Log.d(TAG, "perception.requestFrame duplicate within window: ${req.requestId}")
            return false
        }
        if (perceptionInflight[req.kind]?.isActive == true) {
            Log.d(TAG, "perception.requestFrame skipped: ${req.kind} capture already in flight")
            return false
        }
        perceptionRecent.addLast(RecentPerceptionRequest(req.requestId, now))
        return true
    }

    private suspend fun runPerceptionCapture(
        client: MioClient,
        req: PerceptionRequestFramePayload,
        facing: CameraSession.Facing,
    ) {
        val frame = runCatching { cameraSession.captureFrame(facing) }
            .onFailure { Log.w(TAG, "perception capture failed: ${it.message}") }
            .getOrNull() ?: return

        val args = PerceptionUploadArgs(
            kind = req.kind,
            mediaType = frame.mediaType,
            width = frame.width,
            height = frame.height,
            ts = frame.capturedAtEpochMs,
            requestId = req.requestId,
        )
        val result = client.perceptionUpload(args, frame.bytes)
        if (result.isFailure) {
            Log.w(TAG, "perception.upload failed: ${result.exceptionOrNull()?.message}")
            return
        }

        // Privacy-honest banner — UI-only, no notification. Tagged
        // per-facing so the user knows which camera fired.
        val bannerText = when (facing) {
            CameraSession.Facing.Back -> getString(R.string.perception_banner_back)
            CameraSession.Facing.Front -> getString(R.string.perception_banner_front)
        }
        _perceptionBanner.tryEmit(bannerText)
    }

    /**
     * M-5.3 — capture one screen frame via MediaProjection and ship it
     * through `perception.upload` with `kind = "screen"`. Mirrors
     * [runPerceptionCapture] for the camera path; fires the same
     * privacy-honest banner.
     */
    private suspend fun runScreenPerceptionCapture(
        client: MioClient,
        req: PerceptionRequestFramePayload,
        projection: MediaProjection,
    ) {
        val captureStartMs = System.currentTimeMillis()
        val frame = runCatching { screenCaptureSession.capture(projection) }
            .onFailure { Log.w(TAG, "screen perception capture failed: ${it.message}") }
            .getOrNull()
        if (frame == null) {
            // Make the failure visible so the user knows why Mio says
            // she can't see the screen — without this the user is left
            // wondering whether MediaProjection is alive at all.
            _perceptionBanner.tryEmit(getString(R.string.perception_banner_screen_failed))
            return
        }
        val captureMs = System.currentTimeMillis() - captureStartMs
        Log.d(TAG, "screen perception capture in ${captureMs}ms (${frame.width}x${frame.height})")

        val args = PerceptionUploadArgs(
            kind = req.kind,
            mediaType = frame.mediaType,
            width = frame.width,
            height = frame.height,
            ts = frame.capturedAtEpochMs,
            requestId = req.requestId,
        )
        val uploadStartMs = System.currentTimeMillis()
        val result = client.perceptionUpload(args, frame.bytes)
        if (result.isFailure) {
            Log.w(TAG, "screen perception.upload failed: ${result.exceptionOrNull()?.message}")
            _perceptionBanner.tryEmit(getString(R.string.perception_banner_screen_failed))
            return
        }
        val uploadMs = System.currentTimeMillis() - uploadStartMs
        Log.d(TAG, "screen perception upload in ${uploadMs}ms (${frame.bytes.size} bytes)")
        _perceptionBanner.tryEmit(getString(R.string.perception_banner_screen))
    }

    private fun pruneRecentPerception(nowMs: Long) {
        while (perceptionRecent.isNotEmpty() &&
            nowMs - perceptionRecent.first().tsMs > PERCEPTION_DEDUPE_WINDOW_MS
        ) {
            perceptionRecent.removeFirst()
        }
    }

    private data class RecentPerceptionRequest(val requestId: String, val tsMs: Long)

    /**
     * M-2.7 helper — surface upstream gesture taps from the avatar
     * `WebView` as a `chat.gesture` WS call. Called from the UI layer
     * via the activity-scoped `AvatarController.onGesture` callback.
     */
    fun sendGesture(event: GestureEventPayload) {
        val c = client ?: return
        lifecycleScope.launch {
            c.chatGesture(event).onFailure { err ->
                Log.w(TAG, "chat.gesture failed: ${err.message}")
            }
        }
    }

    /**
     * M-2.8 — push the user's tweaked gesture prefs back to the
     * desktop. The desktop persists them in `userPreferences` and
     * fans the update out via `avatar.setGesturePrefs`, which we
     * receive on the same event stream and cache via [_gesturePrefs].
     * Optimistically updates the local cache so the avatar's WebView
     * gets the new flags immediately even if the WS round-trip is
     * slow; the desktop's echo simply confirms the same values.
     */
    fun pushGesturePrefs(prefs: GesturePrefsPayload) {
        _gesturePrefs.value = prefs
        tryEmitAvatarSignal(AvatarSignal.Prefs(prefs))
        val c = client ?: return
        lifecycleScope.launch {
            c.gesturePrefsSet(prefs).onFailure { err ->
                Log.w(TAG, "gesturePrefs.set failed: ${err.message}")
            }
        }
    }

    private suspend fun bootstrapGesturePrefs(c: MioClient) {
        c.gesturePrefsGet()
            .onSuccess { prefs ->
                _gesturePrefs.value = prefs
                tryEmitAvatarSignal(AvatarSignal.Prefs(prefs))
            }
            .onFailure { err ->
                Log.w(TAG, "gesturePrefs.get bootstrap failed: ${err.message}")
            }
    }

    private fun tryEmitAvatarSignal(signal: AvatarSignal) {
        if (!_avatarSignals.tryEmit(signal)) {
            Log.w(TAG, "avatar signal buffer full; dropping $signal")
        }
    }

    /**
     * Normalise an `audioUrl` (or any other asset URL) emitted by the
     * desktop into one the phone can actually `GET`. The WS transport
     * since M-2.0 rewrites `cortana-asset://<host>/<rel>` payloads into
     * `http://<lan-host>/asset/<host>/<rel>` per-connection using the
     * client's own `Host:` header (see `desktop/src/server/transport/ws.ts`).
     * This helper is the belt-and-suspenders on the phone side:
     *
     *  1. Already-absolute `http://` / `https://` URLs pass through.
     *  2. `cortana-asset://<host>/<rel>` from an older desktop is rewritten
     *     against the paired desktop's coordinates as a fallback.
     *  3. Anything else (path-only) is joined onto the paired host.
     */
    /**
     * Events that should be muted on this phone when the user has
     * turned off "Receive proactive messages". A turn driven from the
     * phone itself bypasses this filter (it stamps `origin = "mobile"`
     * on the wire), so the gate only catches the autonomous cycle's
     * `runInjectedAssistantChatTurn` path and any other no-origin
     * broadcast that would otherwise narrate the chat surface or play
     * Mio's voice from a phone the user wanted silent.
     */
    /**
     * Show [chunk]'s text on the bottom-pill caption after pausing for
     * the prior chunk's reported duration (or a 1.8 s fallback). The
     * resulting timing approximates the cadence the user would hear if
     * audio were on, so muted reading stays sentence-by-sentence
     * instead of all the chunks flashing past in under a second.
     */
    private fun enqueueMutedCaption(chunk: ReplyChunkPayload) {
        val text = chunk.zhText.takeIf { it.isNotBlank() } ?: return
        synchronized(mutedCaptionLock) {
            val previousJob = mutedCaptionJob
            mutedCaptionJob = lifecycleScope.launch {
                previousJob?.join()
                _currentChunkCaption.value = text
                val holdMs = chunk.audioDurationMs?.takeIf { it > 0 } ?: 1_800L
                kotlinx.coroutines.delay(holdMs)
            }
        }
    }

    private fun cancelMutedCaptionQueue() {
        synchronized(mutedCaptionLock) {
            mutedCaptionJob?.cancel()
            mutedCaptionJob = null
        }
    }

    /**
     * M-10 — show the background overlay (floating bubble) if the user
     * enabled it AND has granted SYSTEM_ALERT_WINDOW. Idempotent.
     * Called by [MainActivity.onStop].
     */
    fun showOverlayIfEligible() {
        if (overlayVisible) return
        val prefs = MobilePrefs.get(applicationContext)
        if (!prefs.overlayEnabled.value) return
        val overlay = chatOverlay ?: ChatOverlay(
            context = applicationContext,
            scope = lifecycleScope,
            callbacks = object : ChatOverlay.Callbacks {
                override fun onSend(text: String) {
                    lifecycleScope.launch {
                        sendChat(text).onFailure {
                            Log.w(TAG, "overlay send failed: ${it.message}")
                        }
                    }
                }
                override fun onCaptureCamera() {
                    lifecycleScope.launch { sendCameraCaptureFromOverlay() }
                }
                override fun onCaptureScreen() {
                    lifecycleScope.launch { sendScreenCaptureFromOverlay() }
                }
                override fun onToggleVoice() {
                    val result = toggleVoiceMode()
                    result.onFailure { err ->
                        val message = when (err) {
                            is SecurityException ->
                                getString(R.string.overlay_voice_needs_permission)
                            else -> getString(R.string.chat_voice_unavailable)
                        }
                        Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
                    }
                }
                override fun onOpenApp() {
                    val intent = chatOverlay?.launchAppIntent() ?: return
                    runCatching { startActivity(intent) }
                }
            },
        ).also { chatOverlay = it }

        if (!overlay.canDrawOverlays) {
            Log.w(TAG, "overlay enabled but SYSTEM_ALERT_WINDOW not granted")
            return
        }
        overlay.show(_currentChunkCaption, _voiceMode, _voicePartial)
        overlayVisible = true
    }

    /**
     * M-10 — tear the overlay down. Idempotent. Called by
     * [MainActivity.onStart] so the in-app chat dock isn't mirrored by
     * a redundant overlay while the user is looking at it.
     */
    fun hideOverlay() {
        if (!overlayVisible) return
        chatOverlay?.hide()
        overlayVisible = false
    }

    /**
     * Overlay-side camera capture. Mirrors the in-app camera button:
     * snap a back-cam frame, base64-encode it, and ship it as the next
     * chat turn's `manualImage` (a single short prompt, "(image)", if
     * no text was typed first).
     */
    private suspend fun sendCameraCaptureFromOverlay() {
        // Manual capture path — explicitly excluded from the auto-camera
        // gate (the user just tapped the camera button, that's an
        // unambiguous request). Permission still has to be granted.
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            Log.w(TAG, "overlay camera capture skipped — CAMERA permission not granted")
            return
        }
        val frame = runCatching { cameraSession.captureFrame(CameraSession.Facing.Back) }
            .onFailure { Log.w(TAG, "overlay camera capture failed", it) }
            .getOrNull() ?: return
        val base64 = Base64.encodeToString(frame.bytes, Base64.NO_WRAP)
        sendChat(
            text = "",
            manualImage = AttachedImageArgs(mediaType = frame.mediaType, data = base64),
        ).onFailure { Log.w(TAG, "overlay send-with-camera failed: ${it.message}") }
    }

    /**
     * Overlay-side screen capture. Same shape as
     * [sendCameraCaptureFromOverlay] but pulls the frame from
     * MediaProjection. Returns silently when no projection is held —
     * the user has to grant consent through the main app first.
     */
    private suspend fun sendScreenCaptureFromOverlay() {
        val frame = captureScreenFrame() ?: run {
            Log.d(TAG, "overlay screen capture skipped — no projection")
            return
        }
        val base64 = Base64.encodeToString(frame.bytes, Base64.NO_WRAP)
        sendChat(
            text = "",
            manualImage = AttachedImageArgs(mediaType = frame.mediaType, data = base64),
        ).onFailure { Log.w(TAG, "overlay send-with-screen failed: ${it.message}") }
    }

    private fun shouldGateProactive(event: String): Boolean = when (event) {
        "chat.stream",
        "chat.replyCaption",
        "chat.replyChunk",
        "chat.toolActivity",
        "chat.playUtterance",
        "avatar.setTalking",
        "avatar.setIdle" -> true
        else -> false
    }

    private fun rewriteAssetUrl(payload: PairingPayload, raw: String): String {
        if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
        val cortana = CORTANA_ASSET_RE.matchEntire(raw)
        if (cortana != null) {
            val host = cortana.groupValues[1]
            val rel = cortana.groupValues[2]
            return "http://${payload.host}:${payload.port}/asset/$host/$rel"
        }
        val rel = raw.removePrefix("/")
        return "http://${payload.host}:${payload.port}/$rel"
    }

    private fun appendUserTurn(text: String) {
        _chatLog.value = _chatLog.value + ChatEntry.User(text = text)
    }

    private fun appendStreamDelta(ev: io.mio.mobile.net.ChatStreamEvent) {
        when (ev.type) {
            "start" -> {
                _chatLog.value = _chatLog.value + ChatEntry.Assistant(text = "")
            }
            "text" -> {
                val delta = ev.delta ?: return
                val current = _chatLog.value.toMutableList()
                val last = current.lastOrNull()
                if (last is ChatEntry.Assistant) {
                    current[current.lastIndex] = last.copy(text = last.text + delta)
                } else {
                    current += ChatEntry.Assistant(text = delta)
                }
                _chatLog.value = current
            }
            "end" -> {
                // Caption arrives separately; nothing to do here.
            }
            "error" -> {
                val message = ev.message ?: "unknown error"
                _chatLog.value = _chatLog.value + ChatEntry.System(text = "Error: $message")
            }
        }
    }

    private fun attachCaption(text: String) {
        val current = _chatLog.value.toMutableList()
        val last = current.lastOrNull() as? ChatEntry.Assistant ?: return
        current[current.lastIndex] = last.copy(caption = text)
        _chatLog.value = current
    }

    // ─── Notification ─────────────────────────────────────────────────

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notification_channel_description)
                setShowBadge(false)
            }
            mgr.createNotificationChannel(ch)
        }
        if (mgr.getNotificationChannel(WARNING_CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                WARNING_CHANNEL_ID,
                getString(R.string.warning_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.warning_channel_description)
                setShowBadge(true)
            }
            mgr.createNotificationChannel(ch)
        }
        if (mgr.getNotificationChannel(SURFACE_CHANNEL_ID) == null) {
            // M-6.3 — proactive heads-up channel used by `notify_user`
            // (the agent loop's "tell the user something" tool). Kept
            // separate from `mio.warning.v1` so the user can mute one
            // bucket without losing the other.
            val ch = NotificationChannel(
                SURFACE_CHANNEL_ID,
                getString(R.string.surface_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.surface_channel_description)
                setShowBadge(true)
            }
            mgr.createNotificationChannel(ch)
        }
    }

    private fun postWarningNotification(message: String) {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            1,
            tapIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notif = NotificationCompat.Builder(this, WARNING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.warning_notification_title))
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        mgr.notify(nextWarningId.getAndIncrement(), notif)
    }

    /**
     * (Re-)enter the foreground. The service's effective type is
     * recomputed from current state:
     *  - `dataSync` is always on — the WS connection is the baseline.
     *  - `mediaProjection` rides [includeProjection], which the caller
     *    must opt in for *before* `getMediaProjection` is called
     *    (Android 14+ requires the type set first; the field hasn't
     *    been populated yet at that moment).
     *  - `microphone` rides [includeMicrophone], gated by voice mode.
     *    Without this type, Android 14+ blocks mic access whenever
     *    MainActivity is backgrounded — which is exactly the
     *    floating-bubble case where the recognizer was silently
     *    returning nothing.
     */
    private fun startInForeground(
        notif: Notification,
        includeProjection: Boolean = mediaProjection != null,
        includeMicrophone: Boolean = _voiceMode.value,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (includeProjection) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            }
            if (includeMicrophone) {
                types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            startForeground(NOTIFICATION_ID, notif, types)
        } else {
            startForeground(NOTIFICATION_ID, notif)
        }
    }

    private fun updateNotification() {
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIFICATION_ID, buildNotification(_connState.value))
    }

    private fun buildNotification(state: ConnState): Notification {
        val (titleResId, bodyResId) = when (state) {
            ConnState.Connected -> R.string.notification_title_online to R.string.notification_body_connected
            ConnState.Connecting -> R.string.notification_title_offline to R.string.notification_body_connecting
            ConnState.Disconnected, ConnState.Failed ->
                R.string.notification_title_offline to R.string.notification_body_disconnected
            ConnState.Unpaired -> R.string.notification_title_offline to R.string.notification_body_unpaired
        }
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            tapIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(titleResId))
            .setContentText(getString(bodyResId))
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    sealed interface ChatEntry {
        val text: String

        data class User(override val text: String) : ChatEntry
        data class Assistant(
            override val text: String,
            /** Reply-caption line attached after the stream ends. */
            val caption: String? = null,
        ) : ChatEntry
        data class System(override val text: String) : ChatEntry
    }

    /**
     * Push channel from the WS event loop into the WebView avatar
     * bridge. The UI ([io.mio.mobile.avatar.AvatarController])
     * subscribes to [avatarSignals] and routes each entry into the
     * matching `MioAvatarBridge.set*` push.
     */
    sealed interface AvatarSignal {
        data class Talking(val mood: String?) : AvatarSignal
        object Idle : AvatarSignal
        data class Prefs(val prefs: GesturePrefsPayload) : AvatarSignal
        /**
         * `avatar.setOutfit` arrived over WS. The payload's `vrmPath`
         * has already been rewritten to the bundled APK https URL
         * when a local copy was found; the controller can hand it
         * straight to the bridge without further mapping.
         */
        data class Outfit(val payload: AvatarOutfitPayload) : AvatarSignal
    }

    companion object {
        private const val TAG = "MioFgService"
        const val CHANNEL_ID = "mio.connection.v1"
        /**
         * M-2.6 — separate channel for `chat.showWarning` so the user
         * can mute the sticky connection notification without losing
         * agent-pause alerts (and vice versa).
         */
        const val WARNING_CHANNEL_ID = "mio.warning.v1"

        /**
         * M-6.3 — proactive heads-up channel used by
         * `notification.surface`. Distinct from `WARNING_CHANNEL_ID`
         * so a user who hates the "agent loop paused" alerts can mute
         * that channel without also muting the actual chirps from
         * Mio's `notify_user` tool.
         */
        const val SURFACE_CHANNEL_ID = "mio.surface.v1"

        /** M-6.3 — de-dupe window for repeated `notification.surface` ids. */
        private const val SURFACE_DEDUPE_TTL_MS = 60_000L

        const val NOTIFICATION_ID = 1001
        const val ACTION_RECONNECT = "io.mio.mobile.action.RECONNECT"
        const val ACTION_DISCONNECT = "io.mio.mobile.action.DISCONNECT"

        /**
         * M-3.7 — dedupe window. We assume the agent loop won't
         * legitimately re-issue the same requestId; this is purely to
         * absorb retries from the desktop WS layer if a frame got lost
         * between the call and the (binary) reply. 200 ms is well
         * below any typical re-fire interval, well above LAN round-trip.
         */
        private const val PERCEPTION_DEDUPE_WINDOW_MS = 200L

        private val CORTANA_ASSET_RE = Regex("^cortana-asset://([^/]+)/(.*)$")

        fun startIntent(context: Context): Intent =
            Intent(context, MioForegroundService::class.java).setAction(ACTION_RECONNECT)
    }
}
