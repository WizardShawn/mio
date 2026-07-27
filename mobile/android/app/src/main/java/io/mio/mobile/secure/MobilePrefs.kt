package io.mio.mobile.secure

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * M-2.8 — mobile-only preferences store. Separate from [TokenStore]
 * because nothing here is secret: these are user-tweakable settings
 * that govern the phone UX (haptic feedback, swipe-up assist, etc.)
 * without affecting the desktop side of the pairing.
 *
 * Storage: plain `SharedPreferences` (`mio_mobile_prefs.xml`). No
 * Keystore involvement — losing the file means defaults come back,
 * which is fine for these knobs.
 *
 * Observability: every value is exposed as a [StateFlow] so the
 * Compose layer can recompose when the user flips a toggle in
 * [io.mio.mobile.ui.SettingsScreen] without needing a separate
 * `addOnSharedPreferenceChangeListener` glue.
 */
class MobilePrefs private constructor(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // ─── Haptics ──────────────────────────────────────────────────────
    //
    // The avatar's JS gesture controller fires `hapticTick` on every
    // emitted verb. We translate that into a short Vibrator pulse
    // when this toggle is on, and swallow it when off. Default on —
    // touch feedback is the standard "the device felt your tap"
    // affordance on every modern phone.

    private val _hapticsEnabled = MutableStateFlow(prefs.getBoolean(KEY_HAPTICS, true))
    val hapticsEnabled: StateFlow<Boolean> = _hapticsEnabled.asStateFlow()

    fun setHapticsEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_HAPTICS, enabled) }
        _hapticsEnabled.value = enabled
    }

    // ─── Swipe-up "open history" affordance ───────────────────────────
    //
    // Phase M-2.5 added an off-body upward swipe in the bottom 40 %
    // of the canvas that opens the chat history. Some users prefer
    // the explicit caption-tap path (caption sits at the top of the
    // bottom dock) and find the swipe-up firing while they aim a
    // touch at her shins. This toggle hides the gesture entirely
    // (the JS controller still arms the swipe but the bridge listener
    // gates the open-history call on this pref).

    private val _swipeUpHistoryEnabled = MutableStateFlow(prefs.getBoolean(KEY_SWIPE_UP_HISTORY, true))
    val swipeUpHistoryEnabled: StateFlow<Boolean> = _swipeUpHistoryEnabled.asStateFlow()

    fun setSwipeUpHistoryEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_SWIPE_UP_HISTORY, enabled) }
        _swipeUpHistoryEnabled.value = enabled
    }

    // ─── Receive proactive messages from the agent loop ───────────────
    //
    // The desktop's autonomous cycle (`agent.ts`) occasionally fires a
    // "notable check-in" — Mio spontaneously says something to the
    // operator. By default both clients (desktop chat pill + paired
    // phone) hear those replies, because the cycle isn't attached to
    // any single originating surface. Mobile users who want the phone
    // to stay silent unless they're actively chatting can turn this
    // off; the desktop continues to receive cycles unchanged.
    //
    // Detection is wire-level: events the WS frame stamps
    // `origin: "mobile"` are always processed (the user just sent
    // them), while events with no `origin` (cycle / greeting /
    // notable-check-in) are gated by this flag.

    private val _receiveProactiveReplies = MutableStateFlow(
        prefs.getBoolean(KEY_RECEIVE_PROACTIVE, true),
    )
    val receiveProactiveReplies: StateFlow<Boolean> = _receiveProactiveReplies.asStateFlow()

    fun setReceiveProactiveReplies(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_RECEIVE_PROACTIVE, enabled) }
        _receiveProactiveReplies.value = enabled
    }

    // ─── Voice replies (TTS playback) ─────────────────────────────────
    //
    // Independent of [receiveProactiveReplies]: with this OFF the
    // sentence-paced caption + chat history still update, but the
    // ChunkPlayer doesn't fetch or play the matching WAVs. Useful for
    // a phone the user wants kept silent in a meeting / on transit
    // while still tracking Mio's text replies.

    private val _voiceRepliesEnabled = MutableStateFlow(
        prefs.getBoolean(KEY_VOICE_REPLIES, true),
    )
    val voiceRepliesEnabled: StateFlow<Boolean> = _voiceRepliesEnabled.asStateFlow()

    fun setVoiceRepliesEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_VOICE_REPLIES, enabled) }
        _voiceRepliesEnabled.value = enabled
    }

    // ─── Auto-capture gates ───────────────────────────────────────────
    //
    // These two toggles govern whether the AUTONOMOUS perception pulls
    // (the desktop pushes `perception.requestFrame` when it wants a
    // fresh phone-camera or phone-screen view for the current turn —
    // typed-user, auto-loop cycle, or avatar touch) actually fire on
    // this phone. They do NOT affect the manual capture buttons in the
    // chat bar: those go through `ChatSendOptions.manualImage`, which
    // is a separate path the user explicitly invokes and which DOES
    // get persisted to chat history.
    //
    // Off → the phone silently drops matching `perception.requestFrame`
    // events; the desktop's perception step falls back to the desktop
    // monitor screenshot (or no image, depending on AgentPerceptionMode).
    // On → unchanged behaviour, the phone fulfils the request as before.
    //
    // Default ON for parity with pre-toggle behaviour; users who want a
    // hard "no auto camera / no auto screen-share" stance can flip them
    // off from Settings.

    private val _cameraAutoEnabled = MutableStateFlow(prefs.getBoolean(KEY_CAMERA_AUTO, true))
    val cameraAutoEnabled: StateFlow<Boolean> = _cameraAutoEnabled.asStateFlow()

    fun setCameraAutoEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_CAMERA_AUTO, enabled) }
        _cameraAutoEnabled.value = enabled
    }

    private val _screenAutoEnabled = MutableStateFlow(prefs.getBoolean(KEY_SCREEN_AUTO, true))
    val screenAutoEnabled: StateFlow<Boolean> = _screenAutoEnabled.asStateFlow()

    fun setScreenAutoEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_SCREEN_AUTO, enabled) }
        _screenAutoEnabled.value = enabled
    }

    // ─── Background overlay ───────────────────────────────────────────
    //
    // When ON and the SYSTEM_ALERT_WINDOW permission has been granted,
    // the foreground service paints a floating bubble whenever the
    // main activity goes background; tapping the bubble unfolds it to
    // a chat dock pinned to the bottom of the current screen. Off
    // means no overlay ever shows, regardless of permission.

    private val _overlayEnabled = MutableStateFlow(prefs.getBoolean(KEY_OVERLAY, false))
    val overlayEnabled: StateFlow<Boolean> = _overlayEnabled.asStateFlow()

    fun setOverlayEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_OVERLAY, enabled) }
        _overlayEnabled.value = enabled
    }

    // ─── Voice-input (STT) language ───────────────────────────────────
    //
    // Android's `SpeechRecognizer` transcribes ONE language per
    // session. Deriving it from the device locale is wrong for the
    // common case here: a user on a Chinese-locale phone who speaks
    // English to Mio had every utterance run through the Chinese
    // model — garbage out. This is an explicit pick the user makes in
    // Settings; value is a BCP-47 tag ([VOICE_LANG_EN] / [VOICE_LANG_ZH]).
    // The device locale is only the first-run default guess.

    private val _voiceLanguage = MutableStateFlow(
        normaliseVoiceLanguage(prefs.getString(KEY_VOICE_LANGUAGE, null)),
    )
    val voiceLanguage: StateFlow<String> = _voiceLanguage.asStateFlow()

    fun setVoiceLanguage(tag: String) {
        val normalised = normaliseVoiceLanguage(tag)
        prefs.edit { putString(KEY_VOICE_LANGUAGE, normalised) }
        _voiceLanguage.value = normalised
    }

    /**
     * Clamp any stored / incoming value to a supported tag. A null
     * (never set) falls back to the device-locale guess: English
     * speakers get [VOICE_LANG_EN], everyone else [VOICE_LANG_ZH].
     */
    private fun normaliseVoiceLanguage(raw: String?): String = when {
        raw == VOICE_LANG_EN -> VOICE_LANG_EN
        raw == VOICE_LANG_ZH -> VOICE_LANG_ZH
        java.util.Locale.getDefault().language.equals("en", ignoreCase = true) ->
            VOICE_LANG_EN
        else -> VOICE_LANG_ZH
    }

    // ─── Mobile-side agent loop state ─────────────────────────────────
    //
    // The Agent screen on the phone is intentionally decoupled from the
    // desktop's autonomous loop: the user wants their mobile toggles to
    // reflect *mobile* state and never push pause/resume/enabled across
    // the WS to the desktop (which costs API spend the user is trying
    // to control). These three values back the screen's local status
    // pill and editor — no wire calls happen when they change.

    private val _mobileAgentEnabled = MutableStateFlow(prefs.getBoolean(KEY_MOBILE_AGENT_ENABLED, false))
    val mobileAgentEnabled: StateFlow<Boolean> = _mobileAgentEnabled.asStateFlow()

    fun setMobileAgentEnabled(enabled: Boolean) {
        prefs.edit { putBoolean(KEY_MOBILE_AGENT_ENABLED, enabled) }
        _mobileAgentEnabled.value = enabled
    }

    private val _mobileAgentIntervalMinutes = MutableStateFlow(prefs.getInt(KEY_MOBILE_AGENT_INTERVAL, 10))
    val mobileAgentIntervalMinutes: StateFlow<Int> = _mobileAgentIntervalMinutes.asStateFlow()

    fun setMobileAgentIntervalMinutes(minutes: Int) {
        val clamped = minutes.coerceAtLeast(1)
        prefs.edit { putInt(KEY_MOBILE_AGENT_INTERVAL, clamped) }
        _mobileAgentIntervalMinutes.value = clamped
    }

    private val _mobileAgentPaused = MutableStateFlow(prefs.getBoolean(KEY_MOBILE_AGENT_PAUSED, false))
    val mobileAgentPaused: StateFlow<Boolean> = _mobileAgentPaused.asStateFlow()

    fun setMobileAgentPaused(paused: Boolean) {
        prefs.edit { putBoolean(KEY_MOBILE_AGENT_PAUSED, paused) }
        _mobileAgentPaused.value = paused
    }

    companion object {
        private const val PREFS_NAME = "mio_mobile_prefs"
        private const val KEY_HAPTICS = "haptics.enabled"
        private const val KEY_SWIPE_UP_HISTORY = "swipeUp.history.enabled"
        private const val KEY_VOICE_LANGUAGE = "voice.language"
        private const val KEY_RECEIVE_PROACTIVE = "receive.proactive"
        private const val KEY_VOICE_REPLIES = "voice.replies.enabled"
        private const val KEY_CAMERA_AUTO = "auto.capture.camera"
        private const val KEY_SCREEN_AUTO = "auto.capture.screen"
        private const val KEY_OVERLAY = "overlay.enabled"
        private const val KEY_MOBILE_AGENT_ENABLED = "mobile.agent.enabled"
        private const val KEY_MOBILE_AGENT_INTERVAL = "mobile.agent.intervalMinutes"
        private const val KEY_MOBILE_AGENT_PAUSED = "mobile.agent.paused"

        /** Supported STT language tags — see [voiceLanguage]. */
        const val VOICE_LANG_EN = "en-US"
        const val VOICE_LANG_ZH = "zh-CN"

        @Volatile private var instance: MobilePrefs? = null

        fun get(context: Context): MobilePrefs =
            instance ?: synchronized(this) {
                instance ?: MobilePrefs(context.applicationContext).also { instance = it }
            }
    }
}
