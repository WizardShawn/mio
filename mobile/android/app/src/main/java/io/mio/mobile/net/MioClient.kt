package io.mio.mobile.net

import android.util.Log
import io.mio.mobile.secure.PairingPayload
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/**
 * OkHttp-based WebSocket client for the Mio LAN transport. Implements
 * the wire framing in `desktop/src/shared/protocol.ts > WsClientFrame`
 * / `WsServerFrame` against a single paired desktop.
 *
 * **State machine.** Driven by `connect()` / `disconnect()`; the
 * client manages reconnect internally with exponential backoff +
 * full jitter. `state` is the source of truth for the UI / sticky
 * notification.
 *
 * **Threading.** All I/O happens on the supplied coroutine scope's
 * dispatcher (default IO). OkHttp's listener callbacks fan in onto
 * the same scope via `launch { … }` so consumers can pretend the
 * world is sequential.
 */
class MioClient(
    private val pairing: PairingPayload,
    private val clientVersion: String = "mio-android/0.1",
) {
    enum class State { Idle, Connecting, Connected, Disconnected, Failed }

    private val scopeJob = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + scopeJob)

    private val _state = MutableStateFlow(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _events = MutableSharedFlow<EventFrame>(extraBufferCapacity = 64)
    val events: SharedFlow<EventFrame> = _events.asSharedFlow()

    private val _failures = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val failures: SharedFlow<String> = _failures.asSharedFlow()

    private val callIdSeq = AtomicLong(0)
    private val pendingCalls = mutableMapOf<String, CompletableDeferred<JsonElement?>>()
    private val pendingCallsLock = Any()

    /**
     * Held across the JSON-then-binary pair when invoking
     * `perception.upload` so the two halves are never interleaved with
     * another JSON `call`. The server's `transport/ws.ts` rejects the
     * pending upload if anything else lands between our two frames.
     */
    private val binarySendLock = Mutex()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WS lives forever
        .build()

    private var ws: WebSocket? = null
    private var loopJob: Job? = null
    private var disposed = false

    /**
     * Spin up the connect loop. Idempotent; calling twice is a no-op.
     * Cancel via [disconnect] before re-pairing.
     */
    fun connect() {
        if (disposed) return
        if (loopJob?.isActive == true) return
        loopJob = scope.launch {
            var attempt = 0
            while (isActive && !disposed) {
                _state.value = State.Connecting
                val ok = runOnce()
                if (disposed) break
                _state.value = if (ok) State.Disconnected else State.Failed
                attempt = if (ok) 0 else attempt + 1
                val backoffMs = backoffWithJitter(attempt)
                Log.d(TAG, "reconnecting in ${backoffMs}ms (attempt $attempt)")
                delay(backoffMs)
            }
        }
    }

    fun disconnect() {
        disposed = true
        ws?.close(NORMAL_CLOSE, "client shutdown")
        ws = null
        loopJob?.cancel()
        scopeJob.cancel()
        synchronized(pendingCallsLock) {
            for (deferred in pendingCalls.values) deferred.cancel()
            pendingCalls.clear()
        }
        _state.value = State.Idle
    }

    /**
     * Send a `chat.send` call. The desktop resolves the call AFTER
     * the post-reply TTS hold window — the `await` here will sit on
     * that. Surface the call as fire-and-forget for the UI: the chat
     * stream + reply chunks come in over [events] independently.
     *
     * `manualImage` (M-3.6) attaches a base64-encoded JPEG/PNG so the
     * desktop's chat tool sees the camera frame the user just shot.
     */
    suspend fun chatSend(text: String, manualImage: AttachedImageArgs? = null): Result<Unit> {
        // Always stamp `origin = "mobile"` — every chat turn from this
        // client (typed, STT auto-send, or otherwise) is phone-bound,
        // so the desktop should perceive through the phone's camera +
        // screen, not the desktop monitor.
        val options = ChatSendOptionsArgs(manualImage = manualImage, origin = ORIGIN_MOBILE)
        val argsJson = JSON.encodeToJsonElement(
            ChatSendArgs.serializer(),
            ChatSendArgs(text = text, options = options),
        )
        return runCatching {
            call("chat.send", argsJson)
            Unit
        }
    }

    /**
     * M-2.4 bootstrap: fetch the desktop's persisted gesture prefs
     * right after `welcome`. The service caches the result for the
     * `avatar.requestAssets` -> `getGesturePrefs` RPC the WebView
     * issues on first load, and pushes refreshes through whenever an
     * `avatar.setGesturePrefs` event arrives.
     */
    suspend fun gesturePrefsGet(): Result<GesturePrefsPayload> {
        return runCatching {
            val result = call("gesturePrefs.get", JsonNull)
                ?: throw IllegalStateException("gesturePrefs.get returned null")
            JSON.decodeFromJsonElement(GesturePrefsPayload.serializer(), result)
        }
    }

    /**
     * M-2.8 — push a gesture-prefs change from the mobile Settings
     * screen back to the desktop, which writes it through the same
     * `userPreferences` store the desktop's own Settings → Gestures
     * mutates. The desktop then fans it out to every connected
     * client via `avatar.setGesturePrefs`, including this one — so
     * we don't need to mutate the service-side cache directly here;
     * the round-trip refreshes it.
     */
    suspend fun gesturePrefsSet(prefs: GesturePrefsPayload): Result<Unit> {
        val args = buildJsonObject {
            put("prefs", JSON.encodeToJsonElement(GesturePrefsPayload.serializer(), prefs))
        }
        return runCatching {
            call("gesturePrefs.set", args)
            Unit
        }
    }

    /**
     * Mobile mirror of the desktop's Settings → Agent panel. The
     * desktop's `userPreferences.ts` is the source of truth; we just
     * read and write it over the wire.
     */
    suspend fun agentPrefsGet(): Result<AgentPrefsPayload> {
        return runCatching {
            val result = call("agent.prefsGet", JsonNull)
                ?: throw IllegalStateException("agent.prefsGet returned null")
            JSON.decodeFromJsonElement(AgentPrefsPayload.serializer(), result)
        }
    }

    suspend fun agentPrefsSet(prefs: AgentPrefsPayload): Result<AgentPrefsPayload> {
        val args = JSON.encodeToJsonElement(
            AgentPrefsSetArgs.serializer(),
            AgentPrefsSetArgs(prefs),
        )
        return runCatching {
            val result = call("agent.prefsSet", args)
                ?: throw IllegalStateException("agent.prefsSet returned null")
            JSON.decodeFromJsonElement(AgentPrefsPayload.serializer(), result)
        }
    }

    suspend fun agentStatusGet(): Result<AgentStatusPayload> {
        return runCatching {
            val result = call("agent.statusGet", JsonNull)
                ?: throw IllegalStateException("agent.statusGet returned null")
            JSON.decodeFromJsonElement(AgentStatusPayload.serializer(), result)
        }
    }

    suspend fun agentRunNow(): Result<Unit> {
        return runCatching {
            call("agent.runNow", JsonNull)
            Unit
        }
    }

    suspend fun agentPauseToggle(): Result<AgentStatusPayload> {
        return runCatching {
            val result = call("agent.pauseToggle", JsonNull)
                ?: throw IllegalStateException("agent.pauseToggle returned null")
            JSON.decodeFromJsonElement(AgentStatusPayload.serializer(), result)
        }
    }

    /**
     * M-2.7: forward an avatar-classified touch gesture as a desktop
     * `chat.gesture` call. The desktop side handles synthesizing a
     * reply turn and any associated talking/idle transitions.
     */
    suspend fun chatGesture(event: GestureEventPayload): Result<Unit> {
        val args = JSON.encodeToJsonElement(
            ChatGestureArgs.serializer(),
            ChatGestureArgs(event = event, origin = ORIGIN_MOBILE),
        )
        return runCatching {
            call("chat.gesture", args)
            Unit
        }
    }

    /**
     * M-3.2 — binary-after-call wire pattern. We send the JSON `call`
     * frame for `perception.upload` first, then the binary WS frame
     * carrying the JPEG bytes on the SAME socket, before any other
     * frame. The server's `transport/ws.ts` waits up to 5 s between
     * the two, then resolves the call once the binary arrives.
     *
     * We hold `binarySendLock` across the pair so a concurrent
     * `chat.send` / `chat.gesture` can't interleave a JSON call
     * frame between our JSON and binary halves and break ordering on
     * the server.
     */
    suspend fun perceptionUpload(
        args: PerceptionUploadArgs,
        bytes: ByteArray,
    ): Result<PerceptionUploadResult> {
        if (bytes.isEmpty()) {
            return Result.failure(IllegalArgumentException("perception.upload bytes must not be empty"))
        }
        val argsJson = JSON.encodeToJsonElement(PerceptionUploadArgs.serializer(), args)
        return runCatching {
            val result = binarySendLock.withLock {
                val live = ws ?: throw IllegalStateException("not connected")
                val callId = "c${callIdSeq.incrementAndGet()}-${UUID.randomUUID().toString().take(8)}"
                val deferred = CompletableDeferred<JsonElement?>()
                synchronized(pendingCallsLock) { pendingCalls[callId] = deferred }
                val frame = buildJsonObject {
                    put("kind", "call")
                    put("callId", callId)
                    put("method", "perception.upload")
                    put("args", argsJson)
                }
                if (!live.send(JSON.encodeToString(JsonObject.serializer(), frame))) {
                    synchronized(pendingCallsLock) { pendingCalls.remove(callId) }
                    throw IllegalStateException("send buffer rejected JSON frame")
                }
                if (!live.send(bytes.toByteString(0, bytes.size))) {
                    synchronized(pendingCallsLock) { pendingCalls.remove(callId) }
                    throw IllegalStateException("send buffer rejected binary frame")
                }
                deferred.await()
            }
            val payload = result ?: throw IllegalStateException("perception.upload returned null")
            JSON.decodeFromJsonElement(PerceptionUploadResult.serializer(), payload)
        }
    }

    /**
     * M-5.4 — push the phone's current foreground app to the desktop.
     * Fire-and-forget from the caller's view; the desktop just stores
     * the latest sample for the agent loop to read.
     */
    suspend fun perceptionActiveApp(args: PerceptionActiveAppArgs): Result<Unit> {
        val argsJson = JSON.encodeToJsonElement(PerceptionActiveAppArgs.serializer(), args)
        return runCatching {
            call("perception.activeApp", argsJson)
            Unit
        }
    }

    private suspend fun call(method: String, args: JsonElement): JsonElement? {
        val ws = ws ?: throw IllegalStateException("not connected")
        val callId = "c${callIdSeq.incrementAndGet()}-${UUID.randomUUID().toString().take(8)}"
        val deferred = CompletableDeferred<JsonElement?>()
        synchronized(pendingCallsLock) { pendingCalls[callId] = deferred }
        val frame = buildJsonObject {
            put("kind", "call")
            put("callId", callId)
            put("method", method)
            put("args", args)
        }
        if (!ws.send(JSON.encodeToString(JsonObject.serializer(), frame))) {
            synchronized(pendingCallsLock) { pendingCalls.remove(callId) }
            throw IllegalStateException("send buffer rejected frame")
        }
        return deferred.await()
    }

    // ─── internals ─────────────────────────────────────────────────────

    /**
     * One connection lifecycle. Returns true if we got at least as far
     * as `welcome` (worth treating as a "successful" attempt for
     * backoff purposes); false if the connection died before auth.
     */
    private suspend fun runOnce(): Boolean {
        val url = "ws://${pairing.host}:${pairing.port}/ws"
        Log.d(TAG, "dialling $url as ${pairing.deviceId}")
        val request = Request.Builder().url(url).build()
        val termination = CompletableDeferred<Boolean>()
        val authenticated = AtomicBoolean(false)

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                ws = webSocket
                val hello = buildJsonObject {
                    put("kind", "hello")
                    put("token", pairing.token)
                    put("deviceId", pairing.deviceId)
                    put("clientVersion", clientVersion)
                    put("protocolVersion", PROTOCOL_VERSION)
                }
                webSocket.send(JSON.encodeToString(JsonObject.serializer(), hello))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val element = JSON.parseToJsonElement(text)
                    val obj = element as? JsonObject ?: return
                    when (val kind = obj["kind"]?.toString()?.trim('"')) {
                        "welcome" -> {
                            authenticated.set(true)
                            _state.value = State.Connected
                            Log.d(TAG, "authenticated ok")
                        }
                        "authFailed" -> {
                            val reason = obj["reason"]?.toString()?.trim('"') ?: "unknown"
                            Log.w(TAG, "auth failed: $reason")
                            scope.launch { _failures.emit("auth failed: $reason") }
                            webSocket.close(NORMAL_CLOSE, "auth failed")
                        }
                        "callResult" -> handleCallResult(obj)
                        "event" -> handleEvent(obj)
                        else -> Log.d(TAG, "unhandled frame kind=$kind")
                    }
                } catch (err: Throwable) {
                    Log.w(TAG, "bad server frame: ${err.message}")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // Phase M-1 ignores binary frames; M-3 will route them to
                // perception.upload once that path is wired.
                Log.d(TAG, "binary frame ignored (${bytes.size} bytes)")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "closing: $code $reason")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "closed: $code $reason")
                ws = null
                _state.value = State.Disconnected
                termination.complete(authenticated.get())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure: ${t.message}")
                ws = null
                _state.value = State.Failed
                scope.launch { _failures.emit(t.message ?: "ws failure") }
                termination.complete(false)
            }
        }

        val socket = httpClient.newWebSocket(request, listener)
        return try {
            termination.await()
        } finally {
            runCatching { socket.cancel() }
        }
    }

    private fun handleCallResult(obj: JsonObject) {
        val callId = obj["callId"]?.toString()?.trim('"') ?: return
        val pending = synchronized(pendingCallsLock) { pendingCalls.remove(callId) } ?: return
        val ok = (obj["ok"]?.toString() ?: "false") == "true"
        if (ok) {
            pending.complete(obj["result"] ?: JsonNull)
        } else {
            val err = (obj["error"] as? JsonObject)?.get("message")?.toString()?.trim('"')
            pending.completeExceptionally(IllegalStateException(err ?: "call failed"))
        }
    }

    private fun handleEvent(obj: JsonObject) {
        val event = obj["event"]?.toString()?.trim('"') ?: return
        val payload = obj["payload"] ?: JsonNull
        // Surface-bound events carry an `origin` stamp the desktop's
        // ws transport adds; missing means a no-origin broadcast
        // (agent loop cycle, greeting). The service uses this to gate
        // the "Receive proactive messages" mobile preference.
        val origin = obj["origin"]?.toString()?.trim('"').takeIf { !it.isNullOrEmpty() && it != "null" }
        scope.launch {
            _events.emit(EventFrame(event = event, payload = payload, origin = origin))
        }
    }

    private fun backoffWithJitter(attempt: Int): Long {
        if (attempt <= 0) return 0L
        val capped = min(attempt, 8)
        val baseMs = (BASE_BACKOFF_MS * 2.0.pow(capped - 1)).toLong()
        val ceil = min(baseMs, MAX_BACKOFF_MS)
        return Random.nextLong(0, ceil + 1)
    }

    companion object {
        private const val TAG = "MioClient"
        private const val NORMAL_CLOSE = 1000
        private const val BASE_BACKOFF_MS = 500L
        private const val MAX_BACKOFF_MS = 30_000L

        /** `ChatOrigin` wire value — every turn from this client is phone-bound. */
        private const val ORIGIN_MOBILE = "mobile"

        @JvmField
        val JSON: Json = Json {
            ignoreUnknownKeys = true
            classDiscriminator = "kind"
            encodeDefaults = true
        }

        /** Helper to encode a `chat.send` `args` object outside the call site. */
        fun encodeChatSendArgs(text: String): JsonElement {
            return JSON.encodeToJsonElement(ChatSendArgs.serializer(), ChatSendArgs(text = text))
        }
    }
}
