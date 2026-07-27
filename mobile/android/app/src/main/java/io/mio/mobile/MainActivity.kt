package io.mio.mobile

import android.Manifest
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.provider.Settings
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat
import io.mio.mobile.R
import io.mio.mobile.avatar.AvatarController
import io.mio.mobile.avatar.HapticTicker
import io.mio.mobile.avatar.MioAvatarBridge
import io.mio.mobile.camera.CameraSession
import io.mio.mobile.net.GestureEventPayload
import io.mio.mobile.net.GesturePrefsPayload
import io.mio.mobile.secure.MobilePrefs
import io.mio.mobile.secure.PairingPayload
import io.mio.mobile.secure.PairingUri
import io.mio.mobile.secure.TokenStore
import io.mio.mobile.service.MioAccessibilityService
import io.mio.mobile.service.MioForegroundService
import io.mio.mobile.ui.AgentScreen
import io.mio.mobile.ui.BatteryGuideScreen
import io.mio.mobile.ui.ChatScreen
import io.mio.mobile.ui.GestureGuideScreen
import io.mio.mobile.ui.MioTheme
import io.mio.mobile.ui.PairingScreen
import io.mio.mobile.ui.SettingsScreen
import io.mio.mobile.ui.SettingsState
import kotlinx.coroutines.launch

/**
 * Phase M-1 entry point. Hosts a single Compose tree that swaps
 * between `PairingScreen` (when the desktop hasn't been paired yet)
 * and `ChatScreen` (once a token is in the Keystore). Owns the
 * service binding so the foreground service stays alive across UI
 * configuration changes.
 *
 * The activity is the *only* place that:
 *  - asks for `POST_NOTIFICATIONS` (API 33+) at first launch
 *  - handles the `mio://pair?…` deep-link intent
 *  - starts/stops the foreground service
 */
class MainActivity : ComponentActivity() {

    private var service: MioForegroundService? = null
    private val serviceState = mutableStateOf<MioForegroundService?>(null)

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val b = binder as MioForegroundService.LocalBinder
            service = b.service
            serviceState.value = b.service
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
            serviceState.value = null
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* no-op — service runs without it on pre-33 devices anyway */ }

    // M-3.6 — CAMERA permission gate for the manual capture button.
    // Tracked in Compose state so the camera-capture lambda we hand to
    // ChatScreen can fast-path when the user has already granted it.
    // Permission is request lazily on the first camera tap; we don't
    // up-front prompt here so the user doesn't see two dialogs the
    // first time they open the app (notifications + camera).
    private var hasCameraPermission by mutableStateOf(false)
    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCameraPermission = granted
    }

    // M-4 — RECORD_AUDIO gate for voice-input mode. Same lazy-request
    // approach as the camera: requested on the first mic tap so the
    // first launch never stacks notification + mic dialogs.
    private var hasMicPermission by mutableStateOf(false)
    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasMicPermission = granted
    }

    // M-5 — MediaProjection consent. `createScreenCaptureIntent` must
    // be launched from an Activity; the result is handed straight to
    // the service, which promotes its FGS type and calls
    // `getMediaProjection`.
    private val mediaProjectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        if (result.resultCode == RESULT_OK && data != null) {
            service?.startMediaProjection(result.resultCode, data)
        }
    }

    /**
     * M-10 — SYSTEM_ALERT_WINDOW grant. The system route for this is
     * `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` because the
     * permission is a special "Display over other apps" toggle the
     * user has to flip from the system Settings app rather than the
     * normal runtime grant dialog. We launch the activity and then
     * re-check `Settings.canDrawOverlays` on return.
     */
    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { _ ->
        // The system result code is not reliable here — Android often
        // returns RESULT_CANCELED even on success. Recheck the live
        // grant state instead. If the user came back without granting,
        // we leave the overlay pref ON but the service-side guard in
        // `showOverlayIfEligible` will simply no-op until the grant
        // lands on a subsequent attempt.
    }

    /**
     * Attachment-sheet pickers. `GetContent` returns a Uri to the
     * callback; we bridge to a coroutine via a [CompletableDeferred]
     * so the chat surface can `pickImage()` / `pickPdf()` as a
     * suspend-fn that resolves once the user picks or cancels.
     *
     * The MIME filter at launch time is enforced by the picker UI but
     * the user can still ignore it via "any file" gestures on some
     * launchers, so [readAttachmentFromUri] re-validates the resolved
     * content-resolver type against the Claude-supported allowlist.
     */
    private var pendingImagePick: kotlinx.coroutines.CompletableDeferred<io.mio.mobile.net.AttachedImageArgs?>? = null
    private val pickImageLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        val deferred = pendingImagePick
        pendingImagePick = null
        deferred?.complete(uri?.let { readAttachmentFromUri(it) })
    }

    private var pendingPdfPick: kotlinx.coroutines.CompletableDeferred<io.mio.mobile.net.AttachedImageArgs?>? = null
    private val pickPdfLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        val deferred = pendingPdfPick
        pendingPdfPick = null
        deferred?.complete(uri?.let { readAttachmentFromUri(it) })
    }

    private suspend fun pickImage(): io.mio.mobile.net.AttachedImageArgs? {
        pendingImagePick?.cancel() // shouldn't happen, but don't strand a previous deferred.
        val d = kotlinx.coroutines.CompletableDeferred<io.mio.mobile.net.AttachedImageArgs?>()
        pendingImagePick = d
        runCatching { pickImageLauncher.launch("image/*") }
            .onFailure {
                pendingImagePick = null
                d.complete(null)
            }
        return d.await()
    }

    private suspend fun pickPdf(): io.mio.mobile.net.AttachedImageArgs? {
        pendingPdfPick?.cancel()
        val d = kotlinx.coroutines.CompletableDeferred<io.mio.mobile.net.AttachedImageArgs?>()
        pendingPdfPick = d
        runCatching { pickPdfLauncher.launch("application/pdf") }
            .onFailure {
                pendingPdfPick = null
                d.complete(null)
            }
        return d.await()
    }

    /**
     * Reads a content-Uri into an [AttachedImageArgs]. Rejects any
     * media type outside the Claude API allowlist (image/jpeg|png|
     * gif|webp + application/pdf) and any file larger than
     * [MAX_ATTACHMENT_BYTES] to keep base64 in-memory growth bounded.
     * `null` return ⇒ silently drop and let the caller surface a toast.
     */
    private fun readAttachmentFromUri(uri: android.net.Uri): io.mio.mobile.net.AttachedImageArgs? {
        val resolver = contentResolver
        val rawType = resolver.getType(uri)?.lowercase() ?: return null
        val normalised = when (rawType) {
            "image/jpeg", "image/jpg" -> "image/jpeg"
            "image/png" -> "image/png"
            "image/gif" -> "image/gif"
            "image/webp" -> "image/webp"
            "application/pdf" -> "application/pdf"
            else -> return null
        }
        val bytes = runCatching {
            resolver.openInputStream(uri)?.use { input -> input.readBytes() }
        }.getOrNull() ?: return null
        if (bytes.size > MAX_ATTACHMENT_BYTES) {
            Toast.makeText(
                this,
                getString(R.string.attachment_too_large),
                Toast.LENGTH_SHORT,
            ).show()
            return null
        }
        val base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        return io.mio.mobile.net.AttachedImageArgs(mediaType = normalised, data = base64)
    }

    // Lazily-created CameraX session bound to this activity's
    // LifecycleOwner. The session itself owns no camera until
    // [CameraSession.captureFrame] is called.
    private val cameraSession by lazy { CameraSession(applicationContext, this) }

    /**
     * M-7.1 — pause/resume hook the avatar WebView consults when the
     * device screen toggles. Re-assigned each compose pass via the
     * [AppRoot] callback so [ScreenOnOffReceiver] always sees the
     * latest [AvatarController]. Default no-op keeps things safe
     * before composition completes.
     */
    private var onScreenStateChanged: (Boolean) -> Unit = {}

    private val screenStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> onScreenStateChanged(false)
                Intent.ACTION_SCREEN_ON -> onScreenStateChanged(true)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hasCameraPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        hasMicPermission = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        ensureNotificationPermission()
        startForegroundServiceIfNeeded()

        setContent {
            MioTheme {
                Surface(modifier = Modifier.fillMaxSize().background(Color(0xFF181225))) {
                    val svc = serviceState.value
                    if (svc == null) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Booting service…", color = Color(0xFF9AA3B2))
                        }
                    } else {
                        AppRoot(
                            svc,
                            onCaptureCamera = ::captureCameraFrame,
                            hasCameraPermission = hasCameraPermission,
                            onRequestCameraPermission = ::requestCameraPermission,
                            hasMicPermission = hasMicPermission,
                            onRequestMicPermission = ::requestMicPermission,
                            onRequestScreenCapture = ::requestScreenCapture,
                            onRequestOverlayPermission = ::requestOverlayPermission,
                            onPickImage = ::pickImage,
                            onPickPdf = ::pickPdf,
                            onBindScreenHook = { hook -> onScreenStateChanged = hook },
                            onQuit = ::quitApp,
                        )
                    }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // M-10 — tear the background overlay down as soon as the user
        // brings the main app back to the foreground, so the in-app
        // chat dock isn't mirrored by an overlay drawn on top of it.
        service?.hideOverlay()
        bindService(
            Intent(this, MioForegroundService::class.java),
            connection,
            Context.BIND_AUTO_CREATE,
        )
        // M-7.1 — register the screen on/off receiver here so the
        // hook only listens while the activity is in the visible
        // lifecycle bucket. The receiver MUST be registered at
        // runtime; ACTION_SCREEN_OFF / ACTION_SCREEN_ON are
        // manifest-blacklisted on API 26+.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(screenStateReceiver, filter)
        }
    }

    override fun onStop() {
        super.onStop()
        // M-10 — ask the service to bring up the background overlay
        // (floating bubble) the moment the user navigates away. The
        // service no-ops if the user has disabled the overlay
        // preference or hasn't granted SYSTEM_ALERT_WINDOW yet.
        service?.showOverlayIfEligible()
        runCatching { unbindService(connection) }
        runCatching { unregisterReceiver(screenStateReceiver) }
        service = null
        serviceState.value = null
    }

    /**
     * M-10 — launch the system "Display over other apps" settings page
     * so the user can grant SYSTEM_ALERT_WINDOW. Called by the
     * Settings sheet when the user flips the overlay toggle ON without
     * the permission already granted.
     */
    private fun requestOverlayPermission() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            android.net.Uri.parse("package:$packageName"),
        )
        overlayPermissionLauncher.launch(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumePairingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        consumePairingIntent(intent)
    }

    private fun consumePairingIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val parsed = PairingUri.parse(data) ?: return
        // Apply through the service so it's also responsible for the WS reconnect.
        val s = service
        if (s != null) {
            s.pair(parsed)
        } else {
            // Service not bound yet — store directly and let onCreate hydrate.
            TokenStore.get(this).savePairing(parsed)
            startForegroundServiceIfNeeded()
        }
        intent.data = null
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun startForegroundServiceIfNeeded() {
        val intent = MioForegroundService.startIntent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    /**
     * M-3.6 — entry point for the bottom-row camera shortcut. Returns
     * `null` if we don't yet have CAMERA permission (in that case
     * we've kicked off the runtime grant dialog so the user can retry
     * after granting), or if the capture failed.
     *
     * The capture itself happens on whatever coroutine context the
     * caller provides; [CameraSession.captureFrame] internally
     * marshals to the main thread for CameraX's lifecycle binding.
     */
    private suspend fun captureCameraFrame(
        facing: CameraSession.Facing,
    ): CameraSession.CapturedFrame? {
        if (!hasCameraPermission) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            return null
        }
        return runCatching { cameraSession.captureFrame(facing) }
            .onFailure { Log.w(TAG, "manual camera capture failed", it) }
            .getOrNull()
    }

    /**
     * M-4 — kick off the RECORD_AUDIO runtime grant. Called the first
     * time the user taps the mic without the permission; the voice
     * toggle is a no-op until the grant lands and the user re-taps.
     */
    private fun requestMicPermission() {
        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    /**
     * Kick off the CAMERA runtime grant from the Settings sheet when
     * the user flips the "Let Mio glance through the camera" toggle
     * ON without the permission. Without this the autonomous-camera
     * gate at [MioForegroundService.handleCameraPerceptionRequest]
     * would silently drop every request, leaving the toggle a no-op.
     */
    private fun requestCameraPermission() {
        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    /**
     * M-5.3 — launch the system screen-capture consent dialog. The
     * result callback hands the grant to the service. Until a
     * projection is live the screen-capture button just (re-)opens
     * this dialog.
     */
    private fun requestScreenCapture() {
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjectionLauncher.launch(mgr.createScreenCaptureIntent())
    }

    /**
     * Top-bar "Quit" entry point — a complete exit. Two background
     * components outlive a swiped-away task: the foreground service
     * (with its ongoing notification) and, if the user enabled it, the
     * accessibility service. Both are stopped here so nothing keeps the
     * process alive:
     *  - [MioAccessibilityService.disableIfRunning] turns the
     *    accessibility service off via `disableSelf`.
     *  - [MioForegroundService.shutdown] removes the notification and
     *    calls `stopSelf`.
     *  - `finishAndRemoveTask` drops the last service binding so the
     *    OS can reap the now-empty process.
     */
    private fun quitApp() {
        MioAccessibilityService.disableIfRunning()
        service?.shutdown()
        finishAndRemoveTask()
    }

    companion object {
        private const val TAG = "MioMainActivity"

        /**
         * Hard cap on attachment size — base64 inflates ~33%, and the
         * Anthropic API rejects PDFs over 32 MB outright. 20 MB raw
         * leaves headroom for the encode + JSON framing and keeps the
         * WS frame within polite LAN bounds.
         */
        private const val MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
    }
}

/**
 * The composable that swaps Pairing ↔ Chat. We re-read the service's
 * StateFlows so a successful pair re-routes to chat without a manual
 * navigation step.
 *
 * M-2.3: when chat is active we also own a single [AvatarController]
 * that survives recomposition (`remember(service)`) and is torn down
 * via `DisposableEffect` when the activity unbinds. M-2.4 will hand
 * `service` references for talking/idle pushes through here; M-2.7
 * will route the `onGesture` callback to `service.sendGesture(...)`.
 */
@androidx.compose.runtime.Composable
private fun AppRoot(
    service: MioForegroundService,
    onCaptureCamera: suspend (CameraSession.Facing) -> CameraSession.CapturedFrame?,
    hasCameraPermission: Boolean,
    onRequestCameraPermission: () -> Unit,
    hasMicPermission: Boolean,
    onRequestMicPermission: () -> Unit,
    onRequestScreenCapture: () -> Unit,
    onRequestOverlayPermission: () -> Unit,
    onPickImage: suspend () -> io.mio.mobile.net.AttachedImageArgs?,
    onPickPdf: suspend () -> io.mio.mobile.net.AttachedImageArgs?,
    onBindScreenHook: ((Boolean) -> Unit) -> Unit,
    onQuit: () -> Unit,
) {
    val pairing by service.activePairing.collectAsState()
    val connState by service.connState.collectAsState()
    val chatLog by service.chatLog.collectAsState()
    val screenProjectionAvailable by service.screenProjectionAvailable.collectAsState()
    val serviceGesturePrefs by service.gesturePrefs.collectAsState()
    // Issue-5 — drives the bottom-row caption with one sentence at a
    // time, synced to the matching TTS chunk's playback. When null
    // (initial state or barge-in / new user turn), the caption pill
    // is hidden until Mio's next chunk lands.
    val currentChunkCaption by service.currentChunkCaption.collectAsState()

    if (pairing == null) {
        PairingScreen(
            initialPayload = null,
            onPaired = { service.pair(it) },
        )
        return
    }

    // M-2.5: history-overlay state is owned here so the avatar
    // controller's `onOpenHistory` (off-body swipe-up) and the chat
    // surface (caption tap / dedicated affordance) can both flip it.
    var historyExpanded by remember { mutableStateOf(false) }

    // M-2.8: mobile-only prefs (haptics on/off, swipe-up assist).
    // Hosted by the application context so the values survive
    // Activity recreation; collected here so toggles in the
    // SettingsScreen recompose the avatar wiring immediately.
    val activityContext = androidx.compose.ui.platform.LocalContext.current
    val mobilePrefs = androidx.compose.runtime.remember {
        MobilePrefs.get(activityContext.applicationContext)
    }
    val hapticsEnabled by mobilePrefs.hapticsEnabled.collectAsState()
    val swipeUpHistoryEnabled by mobilePrefs.swipeUpHistoryEnabled.collectAsState()
    val voiceLanguage by mobilePrefs.voiceLanguage.collectAsState()
    val receiveProactiveReplies by mobilePrefs.receiveProactiveReplies.collectAsState()
    val voiceRepliesEnabled by mobilePrefs.voiceRepliesEnabled.collectAsState()
    val cameraAutoEnabled by mobilePrefs.cameraAutoEnabled.collectAsState()
    val screenAutoEnabled by mobilePrefs.screenAutoEnabled.collectAsState()
    val overlayEnabled by mobilePrefs.overlayEnabled.collectAsState()
    // Track SYSTEM_ALERT_WINDOW grant live so the Settings sheet's
    // "Grant" CTA disappears the moment the user comes back from
    // system Settings with the toggle flipped on. We recheck on every
    // ON_RESUME from the activity lifecycle owner.
    var overlayPermissionGranted by remember {
        mutableStateOf(Settings.canDrawOverlays(activityContext))
    }
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                overlayPermissionGranted = Settings.canDrawOverlays(activityContext)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val hapticTicker = androidx.compose.runtime.remember {
        HapticTicker.get(activityContext.applicationContext)
    }

    val avatarController = androidx.compose.runtime.remember(service) {
        AvatarController(
            // M-2.4: we read the service-cached prefs at the moment
            // the WebView issues `getGesturePrefs`. If the bootstrap
            // hasn't returned yet we fall back to permissive defaults
            // so the renderer doesn't stall on first paint; the
            // service will push the real values via [AvatarSignal.Prefs]
            // a moment later.
            getGesturePrefs = {
                val cached = service.gesturePrefs.value
                if (cached != null) {
                    MioAvatarBridge.GesturePrefs(
                        gesturesEnabled = cached.gesturesEnabled,
                    )
                } else {
                    MioAvatarBridge.GesturePrefs(
                        gesturesEnabled = true,
                    )
                }
            },
            onGesture = { event ->
                // M-2.7 — forward to the service which issues the
                // `chat.gesture` WS call.
                service.sendGesture(
                    GestureEventPayload(
                        kind = event.kind,
                        target = event.target,
                        tone = event.tone,
                    ),
                )
            },
            // M-2.5: swipe-up from the bottom 40% of the canvas opens
            // the history overlay. Marshalled onto Compose's thread
            // implicitly — the bridge already pumps through the main
            // looper, and Compose state setters are safe from any
            // thread. M-2.8 gates the actual open on the swipe-up
            // mobile pref so a user who disabled it can't accidentally
            // trigger history when poking near her feet.
            onOpenHistory = {
                if (mobilePrefs.swipeUpHistoryEnabled.value) historyExpanded = true
            },
            // M-2.8: vibrate on each emitted verb. HapticTicker consults
            // MobilePrefs.hapticsEnabled internally, so this can fire
            // unconditionally — the pulse only lands when the user
            // wants it.
            onHaptic = { kind -> hapticTicker.tick(kind) },
        )
    }

    // M-2.4: stream `avatar.*` WS pushes from the service into the
    // bridge. Started/stopped with the composable so the WebView
    // never receives signals while it's torn down.
    androidx.compose.runtime.LaunchedEffect(avatarController, service) {
        service.avatarSignals.collect { signal ->
            when (signal) {
                is MioForegroundService.AvatarSignal.Talking ->
                    avatarController.setTalking(signal.mood)
                MioForegroundService.AvatarSignal.Idle ->
                    avatarController.setIdle()
                is MioForegroundService.AvatarSignal.Prefs ->
                    avatarController.setGesturePrefs(
                        MioAvatarBridge.GesturePrefs(
                            gesturesEnabled = signal.prefs.gesturesEnabled,
                        ),
                    )
                is MioForegroundService.AvatarSignal.Outfit ->
                    avatarController.setOutfit(
                        MioAvatarBridge.OutfitChange(
                            outfitId = signal.payload.outfitId,
                            label = signal.payload.label,
                            vrmPath = signal.payload.vrmPath,
                        ),
                    )
            }
        }
    }

    androidx.compose.runtime.DisposableEffect(avatarController) {
        onDispose { avatarController.release() }
    }

    // M-7.1 — bind the activity-level screen on/off receiver to the
    // current avatar controller so the WebView's JS + RAF loops pause
    // the moment the device screen goes dark. Re-binding on every
    // recompose keeps things correct across configuration changes.
    androidx.compose.runtime.LaunchedEffect(avatarController) {
        onBindScreenHook { isScreenOn ->
            if (isScreenOn) avatarController.resume() else avatarController.pause()
        }
    }
    androidx.compose.runtime.DisposableEffect(avatarController) {
        onDispose { onBindScreenHook {} }
    }

    // M-4 — voice-input mode. The SpeechSession lives inside
    // [MioForegroundService] now so the floating-bubble overlay can
    // drive the same recognizer from outside the activity. The chat
    // surface observes service flows for the mic toggle + listening
    // indicator; spoken segments accumulate into a pending transcript
    // and auto-send through `service.sendChat` after a 6 s pause.
    val voiceContext = androidx.compose.ui.platform.LocalContext.current
    val voiceMode by service.voiceMode.collectAsState()
    val voicePartial by service.voicePartial.collectAsState()

    val onToggleVoice: () -> Unit = {
        val result = service.toggleVoiceMode()
        result.onFailure { err ->
            when (err) {
                is SecurityException -> {
                    if (!hasMicPermission) onRequestMicPermission()
                }
                else -> Toast.makeText(
                    voiceContext,
                    voiceContext.getString(R.string.chat_voice_unavailable),
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    // M-7.2 — battery-guide overlay state. When true we render
    // `BatteryGuideScreen` over the chat surface; back arrow / close
    // button flips it off. Kept here so the controller's WS
    // lifecycle and avatar pause/resume stay untouched while the
    // guide is open.
    var batteryGuideOpen by remember { mutableStateOf(false) }

    // M-2.8 — settings sheet overlay state. The sheet is a separate
    // screen (not a Dialog) so the avatar / chat stay composed
    // behind it; back-arrow flips this off and the user lands back
    // exactly where they were.
    var settingsOpen by remember { mutableStateOf(false) }

    // M-8 — "How to touch the avatar" overlay state. Same pattern as
    // [batteryGuideOpen] / [settingsOpen]: a separate full-screen
    // composable on top of the chat surface, dismissed by the back
    // arrow. Reached from the new info button in the top-right menu.
    var gestureGuideOpen by remember { mutableStateOf(false) }

    // Mobile Agent page overlay state. Sits between info and settings
    // on the top-right menu so the user can answer "is auto loop on /
    // how often?" without reaching for a laptop.
    var agentOpen by remember { mutableStateOf(false) }
    var agentPrefsState by remember { mutableStateOf<io.mio.mobile.net.AgentPrefsPayload?>(null) }
    val agentStatus by service.agentStatus.collectAsState()

    if (batteryGuideOpen) {
        BatteryGuideScreen(onClose = { batteryGuideOpen = false })
        return
    }

    if (gestureGuideOpen) {
        GestureGuideScreen(onClose = { gestureGuideOpen = false })
        return
    }

    if (agentOpen) {
        // Pull a fresh snapshot on entry — the on-the-wire `agent.status`
        // event will keep the status pill live from here on, but the
        // prefs aren't pushed so we have to fetch them once.
        androidx.compose.runtime.LaunchedEffect(Unit) {
            agentPrefsState = service.fetchAgentPrefs()
        }
        AgentScreen(
            initialPrefs = agentPrefsState,
            status = agentStatus,
            onClose = { agentOpen = false },
            onSavePrefs = { next ->
                val saved = service.saveAgentPrefs(next)
                if (saved != null) agentPrefsState = saved
                saved
            },
            onTogglePause = { service.toggleAgentPause() },
            onRunNow = { service.runAgentNow() },
        )
        return
    }

    if (settingsOpen) {
        val cachedPrefs = serviceGesturePrefs
        // The permissive default matches the avatar bootstrap fallback so
        // a user who opens settings before the desktop has answered
        // `gesturePrefs.get` still sees consistent state.
        val gesturesOn = cachedPrefs?.gesturesEnabled ?: true
        SettingsScreen(
            state = SettingsState(
                gesturesEnabled = gesturesOn,
                hapticsEnabled = hapticsEnabled,
                swipeUpHistoryEnabled = swipeUpHistoryEnabled,
                voiceLanguage = voiceLanguage,
                receiveProactiveReplies = receiveProactiveReplies,
                voiceRepliesEnabled = voiceRepliesEnabled,
                cameraAutoEnabled = cameraAutoEnabled,
                cameraPermissionGranted = hasCameraPermission,
                screenAutoEnabled = screenAutoEnabled,
                screenProjectionAvailable = screenProjectionAvailable,
                overlayEnabled = overlayEnabled,
                overlayPermissionGranted = overlayPermissionGranted,
            ),
            onClose = { settingsOpen = false },
            onToggleGesturesEnabled = { value ->
                service.pushGesturePrefs(
                    GesturePrefsPayload(
                        gesturesEnabled = value,
                    ),
                )
            },
            onToggleHaptics = { value -> mobilePrefs.setHapticsEnabled(value) },
            onToggleSwipeUpHistory = { value -> mobilePrefs.setSwipeUpHistoryEnabled(value) },
            onToggleReceiveProactive = { value ->
                mobilePrefs.setReceiveProactiveReplies(value)
            },
            onToggleVoiceReplies = { value ->
                mobilePrefs.setVoiceRepliesEnabled(value)
                // Hard-stop any audio already playing if the user
                // just muted voice replies mid-reply, so the mute
                // takes effect immediately rather than after the
                // current sentence finishes.
                if (!value) service.duckTts()
            },
            onToggleCameraAuto = { value -> mobilePrefs.setCameraAutoEnabled(value) },
            onToggleScreenAuto = { value -> mobilePrefs.setScreenAutoEnabled(value) },
            onToggleOverlay = { value ->
                mobilePrefs.setOverlayEnabled(value)
                // If the user is in the settings sheet and toggles
                // off, immediately tear the overlay down (it'll have
                // been hidden by `onStart` anyway, but this covers the
                // case where the user split-screens settings with
                // another app).
                if (!value) service.hideOverlay()
            },
            onRequestOverlayPermission = onRequestOverlayPermission,
            onRequestCameraPermission = onRequestCameraPermission,
            onRequestScreenCapture = onRequestScreenCapture,
            onSetVoiceLanguage = { tag ->
                // The service's [observeVoiceLanguage] tears down the
                // active SpeechSession on the next emission, but the
                // recognizer is single-language and a stale start would
                // miss the change — toggle off cleanly here so the user
                // re-taps the mic against the freshly-built session.
                if (voiceMode) service.toggleVoiceMode()
                mobilePrefs.setVoiceLanguage(tag)
            },
            onOpenBatteryGuide = {
                settingsOpen = false
                batteryGuideOpen = true
            },
            onUnpair = {
                settingsOpen = false
                service.unpair()
            },
        )
        return
    }

    ChatScreen(
        chatLog = chatLog,
        connState = connState,
        avatarController = avatarController,
        historyExpanded = historyExpanded,
        onHistoryExpandedChange = { historyExpanded = it },
        chunkCaption = currentChunkCaption,
        // M-2.6 — `chat.showWarning` fans out: Snackbar inside the
        // app (this flow), heads-up notification when the process is
        // backgrounded (service-side fallback).
        warningMessages = service.warningMessages,
        // M-3.7 — short-lived banner the service fires whenever it
        // satisfies a `perception.requestFrame`. UI-only; never
        // escalates to a notification.
        perceptionBanner = service.perceptionBanner,
        onSend = { text, manualImage ->
            val res = service.sendChat(text, manualImage)
            res.isSuccess
        },
        // M-3.6 — manual camera shortcut. Returns null if the user
        // hasn't granted CAMERA yet (in which case the activity has
        // launched the system permission dialog) or if the capture
        // failed for any reason.
        onCaptureCamera = onCaptureCamera,
        onCaptureScreen = {
            // M-5.3 — first tap with no live projection opens the
            // consent dialog (returns null, mirroring the camera's
            // permission flow); once granted, later taps capture.
            if (!screenProjectionAvailable) {
                onRequestScreenCapture()
                null
            } else {
                service.captureScreenFrame()
            }
        },
        onPickImage = onPickImage,
        onPickPdf = onPickPdf,
        voiceMode = voiceMode,
        voicePartial = voicePartial,
        onToggleVoice = onToggleVoice,
        onOpenSettings = { settingsOpen = true },
        onOpenInfo = { gestureGuideOpen = true },
        onOpenAgent = { agentOpen = true },
        onQuit = onQuit,
    )
}

@Suppress("unused")
private fun PairingPayload.previewMarker(): String = deviceId
