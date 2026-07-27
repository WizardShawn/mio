package io.mio.mobile.avatar

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.AttributeSet
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * The avatar surface: a transparent WebView that loads the bundled
 * Three.js + three-vrm scene (`file:///android_asset/avatar/index.html`)
 * and hosts the JS↔Kotlin bridge for talking/idle state and gesture
 * upstream.
 *
 * Why a custom subclass rather than configuring a plain WebView in
 * the composable?
 *   - We want one place that configures the transparent-background +
 *     hardware-acceleration + viewport settings; configuring them in
 *     three different call-sites is the kind of subtle drift that
 *     creates "works on my phone" bugs.
 *   - The Compose `AndroidView` factory is the WRONG place to do
 *     anything more than `AvatarWebView(ctx)`. State that needs to
 *     survive recomposition lives here.
 *
 * Thread safety: every public method must be called on the main
 * thread (`WebView` is not thread-safe).
 */
@SuppressLint("SetJavaScriptEnabled") // intentional — the bundled JS *is* the avatar
class AvatarWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : WebView(context, attrs) {

    // Serves the APK's bundled avatar assets (src/main/assets/avatar/**)
    // to the WebView over a virtual https origin. three.js loads the VRM
    // with fetch(), which cannot read file:// URLs, so the scene is
    // served from https://appassets.androidplatform.net/assets/ instead.
    private val assetLoader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(AvatarAssetCatalog.ASSET_HOST)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()

    init {
        configure()
    }

    private fun configure() {
        setBackgroundColor(Color.TRANSPARENT)
        settings.apply {
            javaScriptEnabled = true
            // The desktop renderer uses `import.meta.url` for some resources;
            // the bundle inlines these so DOM-storage isn't actually required,
            // but enabling it costs ~nothing and lets the rare future asset
            // that uses IndexedDB just work.
            domStorageEnabled = true
            // The scene is served via WebViewAssetLoader from a virtual
            // https origin (see `assetLoader`), so direct file:// access
            // is neither needed nor wanted — keep it off.
            allowFileAccess = false
            // Same-origin same-bundle: avatar.html references main.bundle.js
            // and __mioAvatarBridge.js sitting next to it. Cross-origin
            // restrictions inside a single APK directory would be theatre.
            allowContentAccess = false
            // Three.js spins up internal blob URLs for GLB textures; the
            // WebView's `mediaPlaybackRequiresUserGesture` heuristic blocks
            // audio playback on a fresh page-load otherwise. We don't play
            // audio in the WebView, but the flag is cheap insurance.
            mediaPlaybackRequiresUserGesture = false
            // The avatar canvas re-sizes via `window.addEventListener('resize')`;
            // disable WebView's own zoom + scroll fighting for that.
            useWideViewPort = false
            loadWithOverviewMode = false
            builtInZoomControls = false
            setSupportZoom(false)
        }
        // Render with NO view layer. A WebView forced into
        // LAYER_TYPE_HARDWARE draws into an intermediate texture that
        // does not capture the WebGL compositor surface — the three.js
        // canvas comes out blank while the DOM still paints.
        // LAYER_TYPE_NONE keeps the WebView on its direct
        // hardware-accelerated path, which renders WebGL correctly.
        setLayerType(View.LAYER_TYPE_NONE, null)

        webViewClient = object : WebViewClient() {
            // Route requests to the virtual https://appassets... origin
            // through WebViewAssetLoader so they resolve to APK assets.
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String?) {
                Log.d(TAG, "avatar page loaded: $url")
                // Diagnostic: report the three.js canvas + WebGL state
                // once the VRM scene has had time to come up.
                view.postDelayed({
                    view.evaluateJavascript(CANVAS_DIAG_JS) { result ->
                        Log.d(TAG, "[diag] canvas $result")
                    }
                }, 5000)
            }
        }

        // Pipe the avatar scene's JS console to logcat so three.js /
        // three-vrm load failures are diagnosable from `adb logcat`.
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(
                    TAG,
                    "[webview] ${message.message()} " +
                        "(${message.sourceId()}:${message.lineNumber()})",
                )
                return true
            }
        }
    }

    /**
     * Loads the avatar scene. Called once by the host (composable / activity)
     * after the bridge is installed. Safe to call multiple times for a
     * deliberate refresh; the bundled JS is idempotent on a clean DOM.
     */
    fun loadAvatar() {
        loadUrl(AvatarAssetCatalog.INDEX_URL)
    }

    companion object {
        private const val TAG = "AvatarWebView"

        // Reports the three.js canvas geometry + WebGL context health so
        // a blank avatar can be diagnosed from logcat.
        private const val CANVAS_DIAG_JS =
            "(function(){try{" +
                "var c=document.querySelector('canvas');" +
                "if(!c)return JSON.stringify({canvas:'none'});" +
                "var s=getComputedStyle(c);" +
                "var gl=c.getContext('webgl2')||c.getContext('webgl');" +
                "return JSON.stringify({win:[innerWidth,innerHeight]," +
                "dpr:devicePixelRatio,attr:[c.width,c.height]," +
                "client:[c.clientWidth,c.clientHeight],display:s.display," +
                "visibility:s.visibility,opacity:s.opacity," +
                "glLost:gl?gl.isContextLost():'noctx'});" +
                "}catch(e){return 'err:'+e;}})();"
    }
}
