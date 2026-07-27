package io.mio.mobile.stt

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

/**
 * Phase M-4.2 — continuous speech-to-text for voice-input mode, with
 * pause-driven auto-send.
 *
 * `SpeechRecognizer` is single-utterance: it finalizes on a silence
 * gap and then needs an explicit restart. Voice mode wants a session
 * that keeps listening across sentence pauses AND that decides, on its
 * own, when the user is "done" so the transcript can be sent
 * hands-free:
 *
 *  - While the user speaks, partial results stream out through
 *    [onTranscript] as a live preview.
 *  - When the recognizer finalizes a segment (after a sustained pause
 *    — roughly 2 s, the recognizer's natural finalize point), that
 *    segment is committed to an accumulating *pending transcript*. It
 *    is shown, **not** sent.
 *  - If the user resumes speaking, the next finalized segment is
 *    appended to the same pending transcript.
 *  - Once [AUTO_SEND_SILENCE_MS] (6 s) of silence has elapsed since
 *    the user last stopped talking, the whole pending transcript is
 *    handed to [onAutoSend] and cleared. The session keeps listening
 *    for the next utterance.
 *
 * **Threading.** `SpeechRecognizer` must be created and driven on the
 * main thread, and its listener callbacks fire there too. Every public
 * method asserts the main looper.
 */
class SpeechSession(
    context: Context,
    /**
     * BCP-47 tag for the user's spoken input, e.g. "zh-CN" or "en-US".
     * Comes from the user's explicit pick in mobile Settings
     * ([io.mio.mobile.secure.MobilePrefs.voiceLanguage]) — NOT the
     * device locale, so an English speaker on a Chinese-locale phone
     * is transcribed by the English model.
     */
    private val languageTag: String,
) {
    /**
     * The current pending transcript — committed segments plus any
     * live partial. Empty string once an auto-send has flushed it.
     * The UI shows this in the listening indicator.
     */
    var onTranscript: (String) -> Unit = {}

    /**
     * Fires once [AUTO_SEND_SILENCE_MS] of silence has elapsed: the
     * accumulated transcript, ready to send as a chat message.
     */
    var onAutoSend: (String) -> Unit = {}

    /** User started an utterance — the moment to duck Mio's TTS. */
    var onSpeechStart: () -> Unit = {}

    /** Unrecoverable failure; the session has already stopped itself. */
    var onFatal: (String) -> Unit = {}

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audioManager: AudioManager =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var recognizer: SpeechRecognizer? = null

    /** True between [start] and [stop]; gates the restart loop. */
    private var active = false

    /**
     * Some OEM recognizer engines play a short start/stop tone every time
     * `startListening` fires — once per restart, which is jarring in a
     * continuous voice-input session that restarts after every silence
     * gap. We mute the notification + system streams for the lifetime of
     * an active session and restore the user's prior state on [stop] /
     * [destroy]. `STREAM_MUSIC` is deliberately left alone so Mio's
     * incoming TTS chunks still play through the speakers at the user's
     * chosen media volume.
     */
    private var beepMuted = false

    /** Guards against a double `startListening` (ERROR_RECOGNIZER_BUSY). */
    private var listening = false

    /**
     * Run of consecutive non-speech errors (network / client / audio).
     * A sustained run means the recognizer can't work in this
     * environment; the session bails rather than spinning forever.
     */
    private var consecutiveErrors = 0

    /** Committed segments awaiting auto-send; shown but not yet sent. */
    private var pendingTranscript = ""

    /**
     * Most recent partial transcript from the recognizer — the live
     * preview the user sees but that hasn't been finalized yet. We hold
     * onto it so that when the engine ends with empty `onResults` or
     * `onError(NO_MATCH)` (the partial never made it to a final), we
     * can still promote it to [pendingTranscript] and arm the
     * auto-send instead of silently dropping what the user said.
     */
    private var lastPartialResult = ""

    /** `elapsedRealtime` of the most recent end-of-speech (pause start). */
    private var pauseStartElapsed = 0L

    /** The scheduled auto-send, kept so it can be cancelled on its own. */
    private var autoSendRunnable: Runnable? = null

    /**
     * Watchdog scheduled in [onEndOfSpeech]. Some recognizer engines
     * drop the result on the floor — `onEndOfSpeech` fires, but no
     * `onResults` / `onError` callback follows, so the partial the
     * user saw on screen would otherwise be silently lost. This
     * runnable promotes the partial to [pendingTranscript] and arms
     * the auto-send if the engine never finalises in time.
     */
    private var resultWatchdog: Runnable? = null

    /** Whether on-device speech recognition exists at all. */
    val isAvailable: Boolean
        get() = SpeechRecognizer.isRecognitionAvailable(appContext)

    /**
     * Enter voice mode: create the recognizer (lazily) and start the
     * restart-on-silence loop. No-op if already started. If recognition
     * is unavailable the session fires [onFatal] and stays stopped.
     */
    fun start() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "SpeechSession.start must run on the main thread"
        }
        if (active) return
        if (!isAvailable) {
            onFatal("Speech recognition is not available on this device.")
            return
        }
        active = true
        consecutiveErrors = 0
        pendingTranscript = ""
        lastPartialResult = ""
        pauseStartElapsed = 0L
        // Audible confirmation that voice mode is now armed. We play
        // it on STREAM_NOTIFICATION (where the user's "volume" key
        // already controls how loud notifications are) and only then
        // mute the recognizer streams. Order matters: muting first
        // would silence our own tone — and routing it through
        // STREAM_MUSIC means it inherits the music slider, which is
        // routinely set very low and made the cue inaudible.
        playStartTone()
        // Delay the per-restart beep suppression until after our tone
        // has finished, otherwise the mute clobbers it. The recognizer
        // start is delayed by the same amount so the OEM's own start
        // ding (which fires on `startListening`) is still suppressed.
        main.postDelayed({
            if (!active) return@postDelayed
            muteRecognizerBeep(true)
            ensureRecognizer()
            beginListening()
        }, START_TONE_DURATION_MS.toLong() + START_TONE_TAIL_MS)
    }

    /** Exit voice mode. Cancels recognition and drops the pending transcript. */
    fun stop() {
        check(Looper.myLooper() == Looper.getMainLooper()) {
            "SpeechSession.stop must run on the main thread"
        }
        active = false
        listening = false
        cancelAutoSend()
        cancelResultWatchdog()
        pendingTranscript = ""
        lastPartialResult = ""
        main.removeCallbacksAndMessages(null)
        runCatching { recognizer?.cancel() }
        muteRecognizerBeep(false)
    }

    /** Release the recognizer. Call from the owner's `onDispose`. */
    fun destroy() {
        stop()
        runCatching { recognizer?.destroy() }
        recognizer = null
    }

    private fun ensureRecognizer() {
        if (recognizer != null) return
        recognizer = SpeechRecognizer.createSpeechRecognizer(appContext).apply {
            setRecognitionListener(listener)
        }
    }

    private fun beginListening() {
        if (!active || listening) return
        val r = recognizer ?: return
        listening = true
        runCatching { r.startListening(buildIntent()) }
            .onFailure {
                listening = false
                Log.w(TAG, "startListening threw: ${it.message}")
                scheduleRestart()
            }
    }

    private fun scheduleRestart() {
        if (!active) return
        // A short gap avoids ERROR_RECOGNIZER_BUSY from back-to-back
        // start calls and the recognizer's teardown beep on some OEMs.
        main.postDelayed({ beginListening() }, RESTART_DELAY_MS)
    }

    /**
     * (Re-)arm the auto-send for 6 s after the user last stopped
     * talking. The window is measured from [pauseStartElapsed] (the
     * last `onEndOfSpeech`), so a slow recognizer doesn't extend it; if
     * the window has already passed, the send fires immediately.
     */
    private fun scheduleAutoSend() {
        cancelAutoSend()
        if (pendingTranscript.isEmpty()) return
        val elapsed = if (pauseStartElapsed > 0L) {
            SystemClock.elapsedRealtime() - pauseStartElapsed
        } else {
            0L
        }
        val delay = (AUTO_SEND_SILENCE_MS - elapsed).coerceIn(0L, AUTO_SEND_SILENCE_MS)
        val runnable = Runnable {
            autoSendRunnable = null
            val text = pendingTranscript.trim()
            pendingTranscript = ""
            onTranscript("")
            if (text.isNotEmpty()) onAutoSend(text)
        }
        autoSendRunnable = runnable
        main.postDelayed(runnable, delay)
    }

    private fun cancelAutoSend() {
        autoSendRunnable?.let { main.removeCallbacks(it) }
        autoSendRunnable = null
    }

    /**
     * Arm the watchdog that catches the "engine hung after end-of-
     * speech" case — the user finished talking, the recognizer fired
     * `onEndOfSpeech`, but no result callback ever follows. Without
     * this the live partial the user saw would just sit there forever.
     */
    private fun scheduleResultWatchdog() {
        cancelResultWatchdog()
        val runnable = Runnable {
            resultWatchdog = null
            if (!active) return@Runnable
            // If a real result has already armed the auto-send,
            // nothing to do — the engine came through after all.
            if (autoSendRunnable != null) return@Runnable
            // Otherwise: salvage the partial and arm the send so the
            // user's words don't disappear.
            if (lastPartialResult.isNotEmpty()) {
                pendingTranscript = if (pendingTranscript.isEmpty()) {
                    lastPartialResult.trim()
                } else {
                    "$pendingTranscript ${lastPartialResult.trim()}"
                }
                lastPartialResult = ""
                onTranscript(pendingTranscript)
            }
            if (pendingTranscript.isNotEmpty()) {
                scheduleAutoSend()
            }
        }
        resultWatchdog = runnable
        main.postDelayed(runnable, RESULT_WATCHDOG_MS)
    }

    private fun cancelResultWatchdog() {
        resultWatchdog?.let { main.removeCallbacks(it) }
        resultWatchdog = null
    }

    private fun buildIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
            // Some recognizer engines key the result language off the
            // *preference* extra rather than EXTRA_LANGUAGE; set both
            // so the chosen language is honoured regardless of engine.
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, languageTag)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.packageName)
            // Finalize a segment after 1 s of silence (auto-stt). The
            // recognizer's default is engine-defined (typically ~2 s);
            // dropping it to 1 s makes the live caption / pending
            // transcript update sooner so the user sees committed words
            // closer to when they actually stopped saying them. The
            // separate 3-second auto-SEND gate (see [AUTO_SEND_SILENCE_MS])
            // still gives the user room to keep talking.
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
                AUTO_STT_SILENCE_MS,
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                AUTO_STT_SILENCE_MS,
            )
            putExtra(
                RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS,
                0L,
            )
        }

    /**
     * Play a brief confirmation tone on `STREAM_NOTIFICATION` so the
     * user has an audible signal that voice mode is now listening.
     * Notification volume is the right slider for this: it's what the
     * user already tweaks for "system feedback" sounds, separate from
     * the music volume that the streaming TTS rides on.
     *
     * Called from [start] before [muteRecognizerBeep] mutes the
     * notification stream for the rest of the session — the
     * delayed-mute pattern there exists specifically so this tone
     * survives the mute that suppresses per-restart OEM beeps.
     */
    private fun playStartTone() {
        runCatching {
            val tg = ToneGenerator(AudioManager.STREAM_NOTIFICATION, START_TONE_VOLUME)
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, START_TONE_DURATION_MS)
            // ToneGenerator must outlive the tone; release on the main
            // looper after the tone has finished playing.
            main.postDelayed(
                { runCatching { tg.release() } },
                START_TONE_DURATION_MS.toLong() + 200L,
            )
        }.onFailure {
            // ToneGenerator can fail on locked-down devices; the cue is
            // a UX nicety, not load-bearing — log and move on.
            Log.d(TAG, "playStartTone failed: ${it.message}")
        }
    }

    /**
     * Mute (or restore) the streams OEM recognizer engines play their
     * start / stop "listening" tone on. Called bracketing the active
     * session so the tone never plays — even across the implicit
     * restarts that happen after every finalize. `STREAM_MUSIC` is left
     * alone so Mio's incoming TTS chunks still ring through at the
     * user's chosen media volume.
     */
    private fun muteRecognizerBeep(mute: Boolean) {
        if (mute == beepMuted) return
        beepMuted = mute
        val direction = if (mute) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE
        val streams = intArrayOf(
            AudioManager.STREAM_SYSTEM,
            AudioManager.STREAM_NOTIFICATION,
        )
        for (s in streams) {
            runCatching {
                audioManager.adjustStreamVolume(s, direction, 0)
            }.onFailure {
                // Some Android builds reject ADJUST_MUTE for restricted
                // streams (DND, work profiles); the failure is benign,
                // it just means the tone keeps playing on that device.
                Log.d(TAG, "adjustStreamVolume($s, mute=$mute) failed: ${it.message}")
            }
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            consecutiveErrors = 0
        }

        override fun onBeginningOfSpeech() {
            // The user resumed talking — they aren't done, so cancel
            // any pending auto-send. It is re-armed once the next
            // segment finalizes (or, if this turns out to be a false
            // trigger, by the no-match branch of onError). The result
            // watchdog also resets so the post-end-of-speech window
            // is measured fresh from the *next* pause.
            cancelAutoSend()
            cancelResultWatchdog()
            onSpeechStart()
        }

        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            // Mark when this pause began so the 3-second auto-send
            // window is measured from the right moment.
            pauseStartElapsed = SystemClock.elapsedRealtime()
            // Arm the watchdog for the case where the engine drops
            // the result on the floor (no onResults / onError).
            scheduleResultWatchdog()
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val partial = firstResult(partialResults)
            // Remember the latest live transcript so it can be
            // promoted to [pendingTranscript] when the engine ends
            // without a final result (empty onResults / NO_MATCH).
            lastPartialResult = partial
            val combined = when {
                partial.isEmpty() -> pendingTranscript
                pendingTranscript.isEmpty() -> partial
                else -> "$pendingTranscript $partial"
            }
            if (combined.isNotEmpty()) onTranscript(combined)
        }

        override fun onResults(results: Bundle?) {
            listening = false
            consecutiveErrors = 0
            // The engine answered in time — defuse the post-EOS
            // watchdog before it tries to re-promote the same partial.
            cancelResultWatchdog()
            // Fall back to the most recent partial when the engine
            // returns an empty final — partial-but-no-final happens
            // routinely on shorter utterances and was previously lost.
            val raw = firstResult(results)
            val segment = if (raw.isNotEmpty()) raw else lastPartialResult.trim()
            lastPartialResult = ""
            if (segment.isNotEmpty()) {
                // Commit the segment to the pending transcript —
                // shown, not sent — and arm the 3-second auto-send.
                pendingTranscript = if (pendingTranscript.isEmpty()) {
                    segment
                } else {
                    "$pendingTranscript $segment"
                }
                onTranscript(pendingTranscript)
                scheduleAutoSend()
            }
            scheduleRestart()
        }

        override fun onError(error: Int) {
            listening = false
            // Result callback fired — no need for the watchdog to
            // re-promote the same partial behind our back.
            cancelResultWatchdog()
            // Salvage any visible partial so it can ride the auto-send
            // path below — otherwise the user watches their words
            // appear in "Listening: …" then vanish without ever being
            // sent when the engine fails to finalize the segment.
            promotePartialToPending()
            when (error) {
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    active = false
                    cancelAutoSend()
                    onFatal("Microphone permission was denied.")
                }
                // "User didn't say anything" — entirely normal between
                // utterances. If a false beginning-of-speech cancelled
                // the auto-send without a real result re-arming it,
                // re-arm here so a finished transcript never gets stuck.
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    consecutiveErrors = 0
                    if (pendingTranscript.isNotEmpty() && autoSendRunnable == null) {
                        scheduleAutoSend()
                    }
                    scheduleRestart()
                }
                // Network / client / audio / server / busy. A sustained
                // run means the recognizer can't function here.
                else -> {
                    consecutiveErrors += 1
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        active = false
                        cancelAutoSend()
                        onFatal("Speech recognition keeps failing — switching back to typing.")
                    } else {
                        if (pendingTranscript.isNotEmpty() && autoSendRunnable == null) {
                            scheduleAutoSend()
                        }
                        scheduleRestart()
                    }
                }
            }
        }

        /**
         * Move any visible partial into [pendingTranscript] so the
         * auto-send path can pick it up. Called from the error branch:
         * a NO_MATCH or transient failure should not throw away the
         * words the user already saw on screen.
         */
        private fun promotePartialToPending() {
            val partial = lastPartialResult.trim()
            if (partial.isEmpty()) return
            lastPartialResult = ""
            pendingTranscript = if (pendingTranscript.isEmpty()) {
                partial
            } else {
                "$pendingTranscript $partial"
            }
            onTranscript(pendingTranscript)
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun firstResult(bundle: Bundle?): String {
        val list = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        return list?.firstOrNull()?.trim().orEmpty()
    }

    companion object {
        private const val TAG = "SpeechSession"
        // Tight enough to drop minimal audio between restarts, loose
        // enough that back-to-back `startListening` calls don't trip
        // ERROR_RECOGNIZER_BUSY on any engine we've seen.
        private const val RESTART_DELAY_MS = 60L
        private const val MAX_CONSECUTIVE_ERRORS = 5

        /**
         * How long the post-end-of-speech watchdog waits for the
         * engine to deliver a result. Generous on purpose — most
         * engines answer within a few hundred ms of `onEndOfSpeech`,
         * but a hung Bixby / OEM service can sit silent indefinitely.
         * After this fires we promote whatever partial we have so
         * the user's words still make it into the auto-send.
         */
        private const val RESULT_WATCHDOG_MS = 1_200L

        /**
         * Silence (measured from the user's last end-of-speech) after
         * which the recognizer finalises the in-progress segment and
         * commits it to the pending transcript. Lower = the live
         * caption updates sooner; raised too high and the user sees
         * their words still "live" long after they stopped saying them.
         *
         * Bumped to 2 s after the 1.5 s value still cut continuous
         * sentences short on this user's hardware — the OEM engine
         * was finalising on micro-gaps between words. The auto-SEND
         * window ([AUTO_SEND_SILENCE_MS]) is measured from the same
         * pause, so this still leaves a full second of headroom.
         */
        private const val AUTO_STT_SILENCE_MS = 2_000L

        /**
         * Silence (measured from the user's last end-of-speech) after
         * which the accumulated transcript is auto-sent. The user can
         * keep talking — each resumed utterance cancels the pending
         * send and re-arms it once they pause again.
         */
        private const val AUTO_SEND_SILENCE_MS = 3_000L

        /**
         * `ToneGenerator` parameters for the one-shot "voice mode is
         * listening" confirmation cue. Volume 100/100 maxes the
         * relative amplitude — the *absolute* loudness still rides the
         * STREAM_NOTIFICATION slider, so the user controls it through
         * the normal volume key. 160 ms is short enough not to bite
         * into the first word the recognizer is waiting for.
         */
        private const val START_TONE_VOLUME = 100
        private const val START_TONE_DURATION_MS = 160

        /**
         * Extra headroom added after the start tone before
         * [muteRecognizerBeep] applies, so the tone is never clipped
         * by the very mute that's there to silence per-restart beeps.
         * Also pushes the actual `startListening` call past the tone
         * so the recognizer's first ding lands inside the mute window.
         */
        private const val START_TONE_TAIL_MS = 80L
    }
}
