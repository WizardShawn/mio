package io.mio.mobile.avatar

import android.net.Uri
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Kotlin half of the avatar JS↔Kotlin bridge (M-2.2).
 *
 * Registered as a `WebMessageListener` named `MioAvatarBridge` on the
 * WebView's main frame. The matching JS half lives at
 * `mobile/android/avatar-bundler/shim/__mioAvatarBridge.js`, copied
 * into APK assets by the Gradle `bundleMioAssets` task.
 *
 * Wire framing:
 *   JS → Kotlin (postMessage(jsonString)):
 *     - `{ kind: "rpc",  id, method, args? }` — request reply via
 *       `window.__mioAvatarRpcReply(id, ok, payload?)`.
 *     - `{ kind: "fire", method, args? }` — no reply expected.
 *   Kotlin → JS (`webView.evaluateJavascript(...)`):
 *     - `window.__mioAvatarRpcReply(id, ok, payload?)` to resolve an RPC.
 *     - `window.__mioAvatarPush(event, payload)` for one-way pushes
 *       (`"setTalking" | "setIdle" | "setGesturePrefs" | "setOutfit"`).
 *
 * RPC handlers are synchronous from the JS perspective; the bridge
 * resolves their results from in-process state (asset catalog, cached
 * gesture prefs). Fire-and-forget calls go straight to the `Listener`
 * callbacks the host provides. The bridge holds NO reference to the
 * WS client — separation of concerns lives in `MioForegroundService`
 * which adapts WS frames into bridge pushes (wired up in M-2.4).
 */
class MioAvatarBridge(
    private val webView: WebView,
    private val catalog: AvatarAssetCatalog,
    private val listener: Listener,
) {

    interface Listener {
        /** Fired when the WebView's `gestures.ts` classifies a touch into a gesture. */
        fun onGesture(event: GestureEvent)

        /**
         * Fired when the WebView's gesture controller classifies an
         * off-body upward swipe (M-2.5). The host (`AvatarController`)
         * surfaces this to the Compose layer which expands the chat
         * history overlay.
         */
        fun onOpenHistory()

        /**
         * M-2.8 — fired the moment the JS gesture controller emits a
         * verb so the host can vibrate. `kind` is one of the eight
         * gesture verbs (caress / poke / pat / tickle / stroke /
         * grab / tug / pinch) — implementations are free to map it to
         * different vibration patterns, or to a single short pulse,
         * or to silence (when the user has disabled haptics).
         */
        fun onHaptic(kind: String)

        /**
         * RPC handler for `getGesturePrefs`. The bridge calls this on the
         * caller's coroutine context (typically the WebView thread). Return
         * `null` to surface a "prefs not loaded" error to JS.
         */
        fun getGesturePrefs(): GesturePrefs?
    }

    private var installed = false

    /**
     * Hand-rolled twin of the protocol shapes in `net/Protocol.kt`. We
     * keep them local so this file doesn't depend on the network layer —
     * `MioForegroundService` does the translation between the WS
     * `GestureEvent` JSON and this struct.
     */
    @Serializable
    data class GestureEvent(
        val kind: String,
        val target: String,
        val tone: String,
    )

    @Serializable
    data class GesturePrefs(
        val gesturesEnabled: Boolean,
    )

    /**
     * Mirror of `desktop/src/shared/protocol.ts > AvatarOutfitPayload`,
     * normalised to a WebView-ready URL. The foreground service
     * resolves the local APK copy by id (so we avoid mixed-content
     * blocks on the `http://desktop-ip/...` URL the desktop's WS
     * transport produces) before handing the payload to [setOutfit].
     */
    @Serializable
    data class OutfitChange(
        val outfitId: String,
        val label: String,
        val vrmPath: String,
    )

    /**
     * Register the listener. Idempotent; calling twice on the same
     * WebView is a no-op (AndroidX would throw otherwise). Returns
     * false if the runtime WebView doesn't support
     * `WEB_MESSAGE_LISTENER` — we surface that to the caller so it can
     * fall back to a "WebView too old" placeholder instead of silently
     * starving the avatar of host calls.
     */
    fun install(): Boolean {
        if (installed) return true
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(TAG, "WEB_MESSAGE_LISTENER unsupported on this WebView build")
            return false
        }
        // addWebMessageListener throws IllegalArgumentException on a
        // malformed origin rule. Catch it so a bad rule degrades to
        // "avatar without host calls" instead of taking down the whole
        // app from inside the AndroidView factory.
        val added = runCatching {
            WebViewCompat.addWebMessageListener(
                webView,
                JS_BRIDGE_NAME,
                ALLOWED_ORIGINS,
                messageListener,
            )
        }
        if (added.isFailure) {
            Log.w(TAG, "addWebMessageListener rejected: ${added.exceptionOrNull()?.message}")
            return false
        }
        installed = true
        return true
    }

    fun uninstall() {
        if (!installed) return
        runCatching { WebViewCompat.removeWebMessageListener(webView, JS_BRIDGE_NAME) }
        installed = false
    }

    // ─── Pushes (Kotlin → JS) ───────────────────────────────────────────

    /** Drive the talking animation. Always queued on the WebView's main looper. */
    fun setTalking(mood: String?) {
        val payload = buildJsonObject {
            if (mood != null) put("mood", mood) else put("mood", JsonNull)
        }
        pushEvent("setTalking", payload)
    }

    fun setIdle() {
        pushEvent("setIdle", null)
    }

    fun setGesturePrefs(prefs: GesturePrefs) {
        val payload = buildJsonObject {
            put("gesturesEnabled", prefs.gesturesEnabled)
        }
        pushEvent("setGesturePrefs", payload)
    }

    /**
     * Forward an `avatar.setOutfit` push into the WebView so the JS
     * renderer hot-swaps Mio's VRM. Idempotent on the JS side — the
     * renderer noops if the incoming `outfitId` matches its current
     * one.
     */
    fun setOutfit(change: OutfitChange) {
        val payload = buildJsonObject {
            put("outfitId", change.outfitId)
            put("label", change.label)
            put("vrmPath", change.vrmPath)
        }
        pushEvent("setOutfit", payload)
    }

    private fun pushEvent(event: String, payload: JsonElement?) {
        val js = "window.__mioAvatarPush(${quoteJsString(event)}, ${payload?.toString() ?: "null"});"
        webView.post {
            runCatching { webView.evaluateJavascript(js, null) }
                .onFailure { Log.w(TAG, "push $event failed: ${it.message}") }
        }
    }

    // ─── Messages (JS → Kotlin) ─────────────────────────────────────────

    private val messageListener = object : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
        ) {
            if (!isOriginAllowed(sourceOrigin)) {
                Log.w(TAG, "rejecting bridge message from $sourceOrigin")
                return
            }
            val raw = message.data ?: return
            try {
                handleIncoming(raw, replyProxy)
            } catch (err: Throwable) {
                Log.w(TAG, "bridge dispatch failed: ${err.message}")
            }
        }
    }

    private fun handleIncoming(raw: String, replyProxy: JavaScriptReplyProxy) {
        val element = JSON.parseToJsonElement(raw)
        if (element !is JsonObject) {
            Log.w(TAG, "non-object bridge frame: $element")
            return
        }
        val kind = element["kind"]?.jsonPrimitive?.contentOrNullSafe()
        val method = element["method"]?.jsonPrimitive?.contentOrNullSafe()
        val args = element["args"] ?: JsonNull
        when (kind) {
            "rpc" -> {
                val id = element["id"]?.jsonPrimitive?.intOrNullSafe()
                if (id == null || method == null) {
                    Log.w(TAG, "rpc frame missing id/method: $element")
                    return
                }
                handleRpc(id, method, args)
            }
            "fire" -> {
                if (method == null) {
                    Log.w(TAG, "fire frame missing method: $element")
                    return
                }
                handleFire(method, args)
            }
            else -> Log.w(TAG, "unhandled bridge frame kind=$kind")
        }
    }

    private fun handleRpc(id: Int, method: String, @Suppress("UNUSED_PARAMETER") args: JsonElement) {
        when (method) {
            "requestAssets" -> {
                val manifest = catalog.build()
                val payload = buildJsonObject {
                    put("vrmPath", manifest.vrmPath?.let(::JsonPrimitive) ?: JsonNull)
                    put("idleAnimations", stringJsonArray(manifest.idleAnimations))
                    put("talkingAnimations", stringJsonArray(manifest.talkingAnimations))
                    put("extrasAnimations", stringJsonArray(manifest.extrasAnimations))
                    put("outfits", outfitsJsonArray(manifest.outfits))
                    put(
                        "activeOutfitId",
                        manifest.activeOutfitId?.let(::JsonPrimitive) ?: JsonNull,
                    )
                }
                rpcReply(id, ok = true, payload = payload)
            }
            "getGesturePrefs" -> {
                val prefs = listener.getGesturePrefs()
                if (prefs == null) {
                    rpcReply(id, ok = false, payload = buildJsonObject { put("message", "gesture prefs unavailable") })
                } else {
                    val payload = buildJsonObject {
                        put("gesturesEnabled", prefs.gesturesEnabled)
                    }
                    rpcReply(id, ok = true, payload = payload)
                }
            }
            else -> rpcReply(id, ok = false, payload = buildJsonObject { put("message", "unknown method: $method") })
        }
    }

    private fun handleFire(method: String, args: JsonElement) {
        when (method) {
            "sendGesture" -> {
                if (args !is JsonObject) {
                    Log.w(TAG, "sendGesture args not an object: $args")
                    return
                }
                val event = runCatching {
                    JSON.decodeFromJsonElement(GestureEvent.serializer(), args)
                }.getOrNull()
                if (event != null) listener.onGesture(event)
            }
            "openHistory" -> listener.onOpenHistory()
            "hapticTick" -> {
                // M-2.8 — `{ kind: "<verb>" }`. We forward the verb to
                // the listener even if the JSON shape is malformed so a
                // future-protocol payload still pulses; the listener
                // also gracefully no-ops when the user has disabled
                // haptics, so a bad payload can't double-vibrate either.
                val kind = runCatching {
                    (args as? JsonObject)?.get("kind")?.jsonPrimitive?.contentOrNull
                }.getOrNull() ?: ""
                listener.onHaptic(kind)
            }
            else -> Log.w(TAG, "unhandled fire method: $method")
        }
    }

    private fun rpcReply(id: Int, ok: Boolean, payload: JsonElement) {
        val js = "window.__mioAvatarRpcReply($id, $ok, ${payload});"
        webView.post {
            runCatching { webView.evaluateJavascript(js, null) }
                .onFailure { Log.w(TAG, "rpc reply $id failed: ${it.message}") }
        }
    }

    private fun stringJsonArray(items: List<String>): JsonArray = buildJsonArray {
        for (s in items) add(s)
    }

    private fun outfitsJsonArray(items: List<AvatarAssetCatalog.OutfitDescriptor>): JsonArray =
        buildJsonArray {
            for (outfit in items) {
                add(
                    buildJsonObject {
                        put("id", outfit.id)
                        put("label", outfit.label)
                        put("vrmPath", outfit.vrmPath)
                    },
                )
            }
        }

    private fun isOriginAllowed(origin: Uri): Boolean {
        // The avatar page is served by WebViewAssetLoader from the
        // virtual https origin AvatarAssetCatalog.ASSET_HOST. Older
        // builds loaded it as file:// — an opaque origin that surfaces
        // as a file: scheme, as Uri.EMPTY, or as a Uri serialising to
        // the literal "null" (Chrome WebView 147). Accept all of those;
        // the WebView only ever loads our own bundled content anyway.
        val scheme = origin.scheme
        if (scheme != null) {
            if (scheme.equals("file", ignoreCase = true)) return true
            return scheme.equals("https", ignoreCase = true) &&
                origin.host.equals(AvatarAssetCatalog.ASSET_HOST, ignoreCase = true)
        }
        val s = origin.toString()
        return s.isEmpty() || s.equals("null", ignoreCase = true)
    }

    companion object {
        private const val TAG = "MioAvatarBridge"
        private const val JS_BRIDGE_NAME = "MioAvatarBridge"
        // The avatar page loads from file:///android_asset/... . A literal
        // "file://*" rule is rejected by addWebMessageListener
        // (IllegalArgumentException: a file:// origin has no host). The "*"
        // wildcard is the only rule that validly matches a file:// origin;
        // inbound messages are still origin-checked in `isOriginAllowed`.
        private val ALLOWED_ORIGINS = setOf("*")
        private val JSON: Json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }

        private fun quoteJsString(s: String): String {
            val sb = StringBuilder(s.length + 2)
            sb.append('"')
            for (c in s) {
                when (c) {
                    '\\' -> sb.append("\\\\")
                    '"' -> sb.append("\\\"")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    '\b' -> sb.append("\\b")
                    '\u000C' -> sb.append("\\f")
                    else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
                }
            }
            sb.append('"')
            return sb.toString()
        }
    }
}

// Safe wrappers around `JsonPrimitive.content` / `.int` that return null
// on type mismatch instead of throwing — keeps the dispatch code in
// `handleIncoming` linear.
private fun JsonPrimitive.contentOrNullSafe(): String? = runCatching { content }.getOrNull()
private fun JsonPrimitive.intOrNullSafe(): Int? = runCatching { content.toInt() }.getOrNull()
