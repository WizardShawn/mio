package io.mio.mobile.overlay

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleCoroutineScope
import io.mio.mobile.MainActivity
import io.mio.mobile.R
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Floating overlay shown whenever [io.mio.mobile.MainActivity] is not in
 * the foreground. Two modes:
 *
 *  • **Bubble** — a small draggable circle pinned to a screen edge. Tap
 *    to expand to the [Mode.Dock] layout; long-tap (or drag off-screen)
 *    is reserved for future polish.
 *  • **Dock**   — a full-width bottom bar carrying Mio's sentence-paced
 *    caption (the same one the in-app chat pill renders), plus the chat
 *    input row (mic placeholder, camera, screen-share, EditText, send,
 *    and a collapse-to-bubble chevron). Typing + sending stays inside
 *    the overlay — only tapping the caption launches [MainActivity].
 *
 * Requires `SYSTEM_ALERT_WINDOW` ("Display over other apps") to be
 * granted by the user. [canDrawOverlays] returns the live state of that
 * grant; the foreground service's [io.mio.mobile.service.MioForegroundService]
 * checks it before calling [show].
 *
 * Threading: every public method runs on the main thread. State flows
 * are collected with [scope] which the caller provides (the foreground
 * service's `lifecycleScope` so collection ends with the service).
 */
class ChatOverlay(
    private val context: Context,
    private val scope: LifecycleCoroutineScope,
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        /** Send the text from the overlay's EditText through the WS. */
        fun onSend(text: String)
        /** Open the camera capture flow (back camera). */
        fun onCaptureCamera()
        /** Open the screen capture flow (MediaProjection). */
        fun onCaptureScreen()
        /** Toggle service-owned STT (voice-input mode). */
        fun onToggleVoice()
        /** User tapped the caption / dock title — expand into the main activity. */
        fun onOpenApp()
    }

    enum class Mode { Bubble, Dock }

    private val windowManager: WindowManager =
        context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private var mode: Mode = Mode.Bubble
    private var attached = false

    private var bubbleView: View? = null
    private var dockView: View? = null
    private var captionText: TextView? = null
    private var inputField: EditText? = null
    private var micButton: ImageButton? = null

    /** Latest values of the observed flows, retained across mode switches. */
    private var latestCaption: String? = null
    private var latestVoiceMode: Boolean = false
    private var latestVoicePartial: String = ""

    private val collectorJobs = mutableListOf<Job>()

    /**
     * Returns whether the user has granted SYSTEM_ALERT_WINDOW. Tracks
     * the live system state — toggling the system setting between
     * checks updates this answer.
     */
    val canDrawOverlays: Boolean
        get() = Settings.canDrawOverlays(context)

    /**
     * Attach the overlay to the WindowManager. Starts in [Mode.Bubble].
     * Safe to call repeatedly; idempotent when already attached.
     *
     * `voiceModeFlow` + `voicePartialFlow` drive the in-bubble STT
     * affordance: the mic button gets an accent tint while listening,
     * and the dock caption shows the live partial transcript
     * ("Listening: …") instead of Mio's last sentence so the user can
     * confirm what's being captured before the auto-send fires.
     */
    fun show(
        captionFlow: StateFlow<String?>,
        voiceModeFlow: StateFlow<Boolean>,
        voicePartialFlow: StateFlow<String>,
    ) {
        if (attached) return
        if (!canDrawOverlays) {
            Log.w(TAG, "show() ignored — SYSTEM_ALERT_WINDOW not granted")
            return
        }
        attached = true
        attachBubble()
        // Caption updates only paint when the dock is visible; we
        // subscribe regardless so a mode switch picks up the current
        // value without an extra round-trip.
        collectorJobs += scope.launch {
            captionFlow.collect { text ->
                latestCaption = text
                renderCaption()
            }
        }
        collectorJobs += scope.launch {
            voiceModeFlow.collect { active ->
                latestVoiceMode = active
                renderCaption()
                renderMicButton()
            }
        }
        collectorJobs += scope.launch {
            voicePartialFlow.collect { partial ->
                latestVoicePartial = partial
                renderCaption()
            }
        }
    }

    /**
     * Paint whichever line the dock should be showing right now. Voice
     * mode owns the caption while it's on (live partial > placeholder);
     * otherwise we fall through to Mio's sentence-paced reply caption.
     */
    private fun renderCaption() {
        val tv = captionText ?: return
        val text: String = when {
            latestVoiceMode && latestVoicePartial.isNotBlank() -> "Listening: $latestVoicePartial"
            latestVoiceMode -> "Listening…"
            else -> latestCaption.orEmpty()
        }
        tv.text = text
        tv.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
    }

    private fun renderMicButton() {
        micButton?.setColorFilter(if (latestVoiceMode) ACCENT else TEXT_PRIMARY)
    }

    /** Tear the overlay down. Idempotent. */
    fun hide() {
        if (!attached) return
        attached = false
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()
        detachBubble()
        detachDock()
    }

    private fun overlayLayerType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    // ─── Bubble ──────────────────────────────────────────────────────

    private fun attachBubble() {
        if (bubbleView != null) return
        val px = dp(56)
        val container = FrameLayout(context).apply {
            layoutParams = ViewGroup.LayoutParams(px, px)
            background = circleBackground(BUBBLE_BG)
            isClickable = true
            isFocusable = true
        }
        val icon = ImageView(context).apply {
            setImageResource(R.drawable.ic_notification)
            setColorFilter(Color.WHITE)
            val pad = dp(14)
            setPadding(pad, pad, pad, pad)
        }
        container.addView(
            icon,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val params = WindowManager.LayoutParams(
            px,
            px,
            overlayLayerType(),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // Park it ~25% from the top, right-aligned to the screen
            // edge — a familiar Messenger-chat-head resting spot. The
            // user can drag it freely from there.
            val display = windowManager.defaultDisplay
            @Suppress("DEPRECATION")
            val w = display.width
            @Suppress("DEPRECATION")
            val h = display.height
            x = (w - px - dp(16)).coerceAtLeast(dp(16))
            y = (h * 0.25f).toInt()
        }

        container.setOnTouchListener(DragListener(params, onClick = { switchToDock() }))

        runCatching { windowManager.addView(container, params) }
            .onFailure {
                Log.w(TAG, "addView(bubble) failed: ${it.message}")
                bubbleView = null
                return
            }
        bubbleView = container
    }

    private fun detachBubble() {
        val v = bubbleView ?: return
        runCatching { windowManager.removeView(v) }
        bubbleView = null
    }

    // ─── Dock ────────────────────────────────────────────────────────

    private fun attachDock() {
        if (dockView != null) return

        val accent = ACCENT
        val pillBg = circleishBackground(DOCK_BG, dp(20))

        val outer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }

        val caption = TextView(context).apply {
            setTextColor(TEXT_PRIMARY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            background = circleishBackground(DOCK_BG, dp(14))
            setPadding(dp(16), dp(10), dp(16), dp(10))
            visibility = View.GONE
            // Tap the caption → leave the overlay and unfold the app.
            setOnClickListener { callbacks.onOpenApp() }
        }
        outer.addView(
            caption,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { setMargins(0, 0, 0, dp(8)) },
        )

        // Input row: collapse | cam | screen | EditText | send
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            background = circleishBackground(DOCK_BG, dp(24))
            setPadding(dp(6), dp(4), dp(6), dp(4))
            gravity = Gravity.CENTER_VERTICAL
        }

        val collapseBtn = iconButton(android.R.drawable.arrow_down_float) {
            switchToBubble()
        }
        val micBtn = iconButton(android.R.drawable.ic_btn_speak_now) {
            callbacks.onToggleVoice()
        }
        val camBtn = iconButton(android.R.drawable.ic_menu_camera) {
            callbacks.onCaptureCamera()
        }
        val screenBtn = iconButton(android.R.drawable.ic_menu_crop) {
            callbacks.onCaptureScreen()
        }
        val input = EditText(context).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setTextColor(TEXT_PRIMARY)
            setHintTextColor(TEXT_MUTED)
            hint = context.getString(R.string.chat_input_hint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 3
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEND) {
                    triggerSend()
                    true
                } else false
            }
        }
        val sendBtn = iconButton(android.R.drawable.ic_menu_send) {
            triggerSend()
        }.apply {
            setColorFilter(accent)
        }

        row.addView(collapseBtn, btnSize())
        row.addView(micBtn, btnSize())
        row.addView(camBtn, btnSize())
        row.addView(screenBtn, btnSize())
        row.addView(
            input,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(dp(6), 0, dp(6), 0)
            },
        )
        row.addView(sendBtn, btnSize())

        outer.addView(
            row,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayLayerType(),
            // We deliberately make the dock focusable so the EditText
            // can receive keyboard input. ADJUST_RESIZE-ish behaviour
            // on overlay windows is iffy; we keep it simple and let
            // the soft keyboard push us up at the system level.
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.START
            x = 0
            y = dp(8)
            // Bring up the IME automatically when the dock attaches, so
            // tapping the bubble feels like "open and start typing".
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN
        }

        runCatching { windowManager.addView(outer, params) }
            .onFailure {
                Log.w(TAG, "addView(dock) failed: ${it.message}")
                dockView = null
                captionText = null
                inputField = null
                return
            }
        dockView = outer
        captionText = caption
        inputField = input
        micButton = micBtn

        // Reflect the current caption immediately on attach so the user
        // sees the in-flight reply (if any) right away. State-flow
        // collectors running in [show] update everything going forward.
        renderCaption()
        renderMicButton()
    }

    private fun detachDock() {
        val v = dockView ?: return
        runCatching { windowManager.removeView(v) }
        dockView = null
        captionText = null
        inputField = null
        micButton = null
    }

    // ─── Mode switching ──────────────────────────────────────────────

    private fun switchToDock() {
        if (mode == Mode.Dock) return
        mode = Mode.Dock
        detachBubble()
        attachDock()
        // Soft-show the keyboard so the user can start typing without
        // a second tap. The dock window is focusable when the EditText
        // is touched; we punt to the user for the first tap.
    }

    private fun switchToBubble() {
        if (mode == Mode.Bubble) return
        mode = Mode.Bubble
        hideKeyboard()
        detachDock()
        attachBubble()
    }

    private fun triggerSend() {
        val text = inputField?.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        callbacks.onSend(text)
        inputField?.setText("")
    }

    private fun hideKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        inputField?.windowToken?.let { imm?.hideSoftInputFromWindow(it, 0) }
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    private fun iconButton(drawableRes: Int, onClick: () -> Unit): ImageButton {
        return ImageButton(context).apply {
            setImageResource(drawableRes)
            background = circleBackground(Color.TRANSPARENT)
            setColorFilter(TEXT_PRIMARY)
            setOnClickListener { onClick() }
            val pad = dp(8)
            setPadding(pad, pad, pad, pad)
        }
    }

    private fun btnSize(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(dp(40), dp(40))

    private fun circleBackground(color: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(color)
        }

    private fun circleishBackground(color: Int, radiusDp: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(color)
        }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            context.resources.displayMetrics,
        ).toInt()

    /**
     * Drag handler that distinguishes a tap (no movement) from a drag
     * (movement > [TAP_SLOP_DP]). Calls [onClick] on tap; otherwise
     * updates the WindowManager position so the bubble follows the
     * user's finger.
     */
    private inner class DragListener(
        private val params: WindowManager.LayoutParams,
        private val onClick: () -> Unit,
    ) : View.OnTouchListener {
        private var startX = 0f
        private var startY = 0f
        private var paramStartX = 0
        private var paramStartY = 0
        private val slop = dp(8)

        @Suppress("ClickableViewAccessibility")
        override fun onTouch(v: View, event: MotionEvent): Boolean {
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX
                    startY = event.rawY
                    paramStartX = params.x
                    paramStartY = params.y
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - startX).toInt()
                    val dy = (event.rawY - startY).toInt()
                    params.x = paramStartX + dx
                    params.y = paramStartY + dy
                    runCatching { windowManager.updateViewLayout(v, params) }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    val dx = abs(event.rawX - startX).toInt()
                    val dy = abs(event.rawY - startY).toInt()
                    if (dx < slop && dy < slop) onClick()
                    return true
                }
            }
            return false
        }
    }

    /**
     * Build an intent that launches MainActivity over the current task
     * (e.g. the foreground app the user has running). The activity's
     * `singleTask` mode + the NEW_TASK flag make this bring the
     * existing app to front rather than start a fresh task.
     */
    fun launchAppIntent(): Intent =
        Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }

    companion object {
        private const val TAG = "ChatOverlay"

        // Chrome colours mirror MioMenuButtonColor / MioInputPillColor
        // from the in-app ChatScreen so the overlay reads as the same
        // surface family when the user pops back and forth.
        private val BUBBLE_BG = Color.parseColor("#E61B1F29")
        private val DOCK_BG = Color.parseColor("#E61B1F29")
        private val ACCENT = Color.parseColor("#FFD07A")
        private val TEXT_PRIMARY = Color.parseColor("#E9ECF2")
        private val TEXT_MUTED = Color.parseColor("#9AA3B2")
    }
}
