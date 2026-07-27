package io.mio.mobile.avatar

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Compose host for the avatar WebView (M-2.3). Lives at any
 * `fillMaxSize`-ish position in the Compose tree; on M-2.3's
 * Grok-Mika layout it occupies the entire `Box` behind the chat
 * surface.
 *
 * Lifecycle:
 *   - The WebView + `MioAvatarBridge` are constructed once per
 *     [AvatarController]; subsequent recompositions (theme change,
 *     state change) re-use the existing instances via `remember`.
 *   - The composable runs the bridge `install()` lazily on first
 *     compose, then `loadAvatar()` once. Dispose hooks tear both
 *     down so an Activity recreation doesn't leak a WebView.
 *   - Pushes from outside (e.g. `MioForegroundService` observing
 *     `avatar.setTalking`) call into the controller — see M-2.4 for
 *     that wiring.
 */
@Composable
fun AvatarSurface(
    controller: AvatarController,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    AndroidView(
        factory = {
            controller.attach(context)
            controller.webViewOrNull()
                ?: error("AvatarController.attach() must produce a WebView before AndroidView reads it")
        },
        modifier = modifier,
    )

    LaunchedEffect(controller) {
        controller.bootIfNeeded()
    }

    DisposableEffect(controller) {
        onDispose {
            // The controller's own lifecycle (Activity-scoped via
            // `remember(...) { … }`) handles destroy. We DO want to
            // remove the WebView from any prior parent so the next
            // `AndroidView.factory` invocation can re-attach without
            // an "already has a parent" runtime crash.
            controller.detachFromParent()
        }
    }
}

/**
 * Activity-scoped owner of the avatar `WebView` + `MioAvatarBridge`.
 * Constructed by the host composable's `remember(...)` block.
 *
 * Pattern: this class is the bridge between (a) the WS event stream
 * carried by [io.mio.mobile.service.MioForegroundService] and (b) the
 * WebView showing Mio. M-2.4 will wire the service to call
 * [setTalking] / [setIdle] / [setGesturePrefs] on receipt of the
 * matching `avatar.*` WS events.
 *
 * Threading: every public method is safe from the main thread. The
 * push primitives marshal onto the WebView's looper before touching
 * the WebView.
 */
class AvatarController(
    /**
     * Bootstrap supplier of gesture prefs. M-2.4 hands the
     * service's cached prefs through here; the bridge falls back to
     * permissive defaults so the WebView doesn't stall on
     * `requestAssets` before the service-side bootstrap completes.
     */
    private val getGesturePrefs: () -> MioAvatarBridge.GesturePrefs,
    /**
     * Receiver for upstream gestures (`bridge.sendGesture` → WS
     * `chat.gesture` call). M-2.7 wires this to `MioClient`.
     */
    private val onGesture: (MioAvatarBridge.GestureEvent) -> Unit,
    /**
     * Receiver for the M-2.5 off-body swipe-up gesture. Wired by the
     * host activity to the same state slot that drives the chat
     * history overlay.
     */
    private val onOpenHistory: () -> Unit,
    /**
     * M-2.8 — receiver for the JS gesture controller's haptic ticks.
     * Wired to a Vibrator-backed helper that gates on the user's
     * Haptics mobile pref. Default no-op keeps the controller safe
     * when haptics aren't desired (or unavailable).
     */
    private val onHaptic: (String) -> Unit = {},
) {

    private var webView: AvatarWebView? = null
    private var bridge: MioAvatarBridge? = null
    private var booted = false

    internal fun attach(context: android.content.Context) {
        if (webView != null) return
        val view = AvatarWebView(context.applicationContext)
        val br = MioAvatarBridge(
            webView = view,
            catalog = AvatarAssetCatalog(context.applicationContext),
            listener = object : MioAvatarBridge.Listener {
                override fun onGesture(event: MioAvatarBridge.GestureEvent) {
                    this@AvatarController.onGesture(event)
                }
                override fun onOpenHistory() {
                    this@AvatarController.onOpenHistory()
                }
                override fun onHaptic(kind: String) {
                    this@AvatarController.onHaptic(kind)
                }
                override fun getGesturePrefs(): MioAvatarBridge.GesturePrefs = this@AvatarController.getGesturePrefs()
            },
        )
        val installed = br.install()
        if (!installed) {
            Log.w(TAG, "MioAvatarBridge.install() returned false — host WebView is too old; avatar will render without host calls")
        }
        webView = view
        bridge = br
    }

    internal fun webViewOrNull(): AvatarWebView? = webView

    internal fun bootIfNeeded() {
        if (booted) return
        webView?.loadAvatar()
        booted = true
    }

    internal fun detachFromParent() {
        val view = webView ?: return
        val parent = view.parent as? android.view.ViewGroup ?: return
        parent.removeView(view)
    }

    fun setTalking(mood: String?) {
        bridge?.setTalking(mood)
    }

    fun setIdle() {
        bridge?.setIdle()
    }

    fun setGesturePrefs(prefs: MioAvatarBridge.GesturePrefs) {
        bridge?.setGesturePrefs(prefs)
    }

    /**
     * M-2.4 — `avatar.setOutfit` WS event → bridge push → renderer
     * hot-swaps Mio's VRM. The foreground service is responsible for
     * rewriting [MioAvatarBridge.OutfitChange.vrmPath] to a local APK
     * https URL before this is called, so the page (served from the
     * `appassets.androidplatform.net` virtual origin) doesn't trip
     * mixed-content on a plain-`http://` VRM fetch.
     */
    fun setOutfit(change: MioAvatarBridge.OutfitChange) {
        bridge?.setOutfit(change)
    }

    /**
     * M-7.1 — suspend the avatar scene when the device screen turns
     * off. `WebView.onPause` halts JS timers + `requestAnimationFrame`
     * cycles in the rendering surface, which is the main driver of
     * idle drain. Cheap to call multiple times.
     */
    fun pause() {
        webView?.onPause()
    }

    /**
     * M-7.1 — counterpart of [pause]. Resumes JS + animation timers.
     */
    fun resume() {
        webView?.onResume()
    }

    /** Tear down — call from the hosting Activity's `onDestroy`. */
    fun release() {
        booted = false
        bridge?.uninstall()
        bridge = null
        webView?.let { v ->
            (v.parent as? android.view.ViewGroup)?.removeView(v)
            v.destroy()
        }
        webView = null
    }

    companion object {
        private const val TAG = "AvatarController"
    }
}
