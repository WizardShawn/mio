package io.mio.mobile.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement

/**
 * Hand-mirrored Kotlin twin of `desktop/src/shared/protocol.ts`.
 *
 * **The contract is canonical on the desktop.** When `protocol.ts`
 * changes, this file changes in lockstep. A Phase M-1 unit test
 * (TODO Phase M-2 polish) serialises the same fixture both sides and
 * compares bytes; until then, code review on every PR is the gate.
 *
 * Phase M-1 only needs the chat surface + the auth handshake; Phase
 * M-3+ adds `perception.upload` / `perception.activeApp` here.
 */
const val PROTOCOL_VERSION: Int = 0

// ─── Server → client event payload shapes ──────────────────────────────

@Serializable
data class ChatStreamEvent(
    val type: String, // "start" | "text" | "error" | "end"
    val delta: String? = null,
    val message: String? = null,
    val stopReason: String? = null,
)

@Serializable
data class ReplyCaptionPayload(
    val text: String,
    /** "zh-Hant" | "ja". */
    val language: String,
)

@Serializable
data class ReplyChunkPayload(
    val chunkIndex: Int,
    val totalChunks: Int,
    val zhText: String,
    /** Server returns null when TTS synthesis was skipped (no Gemini key). */
    val audioUrl: String? = null,
    val audioDurationMs: Long? = null,
)

@Serializable
data class ChatToolActivityPayload(
    val text: String? = null,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > 'chat.showWarning'`. The
 * brain emits this when the agent loop is paused (rate-cap, repeated
 * errors); M-2.6 surfaces it on the phone as either a Snackbar or a
 * heads-up notification depending on whether the UI is foreground.
 */
@Serializable
data class ChatWarningPayload(
    val message: String,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > NotificationSurfacePayload`
 * (Phase M-6). The desktop emits this whenever the agent loop's
 * `notify_user` tool fires; the mobile foreground service renders it
 * as a heads-up on the `mio.surface.v1` channel with a tap-back into
 * `MainActivity`. `priority` maps to Android importance buckets:
 * `"normal"` → `IMPORTANCE_DEFAULT`, `"high"` → `IMPORTANCE_HIGH`.
 */
@Serializable
data class NotificationSurfacePayload(
    val title: String,
    val body: String,
    /** "normal" | "high". */
    val priority: String,
    val id: String? = null,
    val emittedAt: Long = 0L,
)

@Serializable
data class UtterancePayload(
    val text: String,
    val audioUrl: String? = null,
    val audioOnly: Boolean? = null,
)

@Serializable
data class AvatarTalkingPayload(
    /** ReplyMood enum on desktop side; kept loose here. */
    val mood: String? = null,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > AvatarOutfitPayload` —
 * the body of `avatar.setOutfit` events emitted by the desktop brain
 * whenever Mio's `change_clothes` tool runs. The WS transport
 * rewrites `vrmPath` from the desktop's absolute filesystem path to
 * `http://<host>/asset/local/<rel>` for over-the-wire delivery, but
 * the mobile side ALWAYS resolves to the bundled APK copy of the
 * matching outfit id when one exists — both for speed and so the
 * page (loaded from the `https://appassets…` virtual origin) doesn't
 * trip the WebView's mixed-content block on a plain-HTTP VRM fetch.
 */
@Serializable
data class AvatarOutfitPayload(
    val outfitId: String,
    val label: String,
    val vrmPath: String,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > GesturePrefs`. The avatar
 * bridge consumes this via M-2.4's bootstrap + WS push pathway and
 * M-2.7's upstream `chat.gesture` flow.
 */
@Serializable
data class GesturePrefsPayload(
    val gesturesEnabled: Boolean,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > GestureEvent` — used as
 * the args body for `chat.gesture` (M-2.7).
 */
@Serializable
data class GestureEventPayload(
    val kind: String,
    val target: String,
    val tone: String,
)

@Serializable
data class ChatGestureArgs(
    val event: GestureEventPayload,
    /**
     * Surface the touch came from — always `"mobile"` from this
     * client, so a touch on the phone's avatar pulls the phone's
     * camera + screen for perception. Mirror of `protocol.ts >
     * ChatOrigin`.
     */
    val origin: String? = null,
)

// ─── Mobile perception (Phase M-3.1) ──────────────────────────────────
//
// Mirror of `desktop/src/shared/protocol.ts > PerceptionUploadArgs` and
// `PerceptionRequestFramePayload`. The `perception.upload` call uses
// the "binary-after-call" wire pattern: this JSON args object is sent
// first, followed immediately by ONE binary WS frame on the same
// socket carrying the encoded image bytes.

/**
 * Allowed values: "back-cam" | "front-cam" | "screen". Kept as a
 * String here so we can grow the enum on the desktop without forcing
 * a Kotlin recompile; runtime callers should clamp to the four
 * documented values.
 */
@Serializable
data class PerceptionUploadArgs(
    val kind: String,
    /** "image/jpeg" only in v0; reserved for AVIF/WebP/PNG later. */
    val mediaType: String,
    val width: Int,
    val height: Int,
    /** Client capture timestamp (epoch ms). */
    val ts: Long,
    /** Echo of the originating `perception.requestFrame.requestId`, when one exists. */
    val requestId: String? = null,
    /** Optional byte count of the binary that follows on the wire. */
    val byteLength: Long? = null,
)

@Serializable
data class PerceptionUploadResult(
    val frameId: String,
)

@Serializable
data class PerceptionRequestFramePayload(
    val kind: String,
    val requestId: String,
    val reason: String? = null,
    /** Epoch-ms absolute deadline for staleness short-circuit. */
    val notLaterThan: Long? = null,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > MobileActiveApp` — the
 * args body for the `perception.activeApp` method (Phase M-5.4). The
 * Android `MioAccessibilityService` reads the foreground package name
 * ONLY; `activityLabel` is resolved on-device via `PackageManager`.
 */
@Serializable
data class PerceptionActiveAppArgs(
    val packageName: String,
    val activityLabel: String,
    /** Client capture timestamp (epoch ms). */
    val ts: Long,
)

@Serializable
data class AgentStatusPayload(
    val state: String,
    val reason: String? = null,
    val lastRunAt: Long? = null,
    val nextRunAt: Long? = null,
    val cyclesToday: Int = 0,
    val estimatedCostUsdToday: Double = 0.0,
    val consecutiveErrors: Int = 0,
    val imagesToday: Int = 0,
    val dailyImageCap: Int = 0,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > AgentPrefs`. The phone
 * Agent screen reads + writes these to control the desktop's autonomous
 * loop (enable, interval, daily/hourly caps, notable check-in surface,
 * perception mode). `perceptionMode` is optional on the wire — the
 * desktop fills a default; we keep it nullable to avoid having to send
 * one back if the user hasn't touched it.
 */
@Serializable
data class AgentPrefsPayload(
    val enabled: Boolean,
    val intervalMinutes: Int,
    val dailyCostCapUsd: Double,
    val hourlyCycleCap: Int,
    val hourlyNotifyCap: Int,
    val notableCheckInChat: Boolean,
    val perceptionMode: String? = null,
)

@Serializable
data class AgentPrefsSetArgs(val prefs: AgentPrefsPayload)

// ─── Client → server frames (`WsClientFrame`) ──────────────────────────

@Serializable
@JsonClassDiscriminator("kind")
sealed interface WsClientFrame

@Serializable
@SerialName("hello")
data class HelloFrame(
    val token: String,
    val deviceId: String,
    val clientVersion: String,
    val protocolVersion: Int = PROTOCOL_VERSION,
) : WsClientFrame

@Serializable
@SerialName("call")
data class CallFrame(
    val callId: String,
    /** Dot-separated wire name, e.g. `chat.send`. */
    val method: String,
    val args: JsonElement,
) : WsClientFrame

// ─── Server → client frames (`WsServerFrame`) ──────────────────────────

@Serializable
@JsonClassDiscriminator("kind")
sealed interface WsServerFrame

@Serializable
@SerialName("welcome")
data class WelcomeFrame(
    val serverVersion: String,
    val protocolVersion: Int,
) : WsServerFrame

@Serializable
@SerialName("authFailed")
data class AuthFailedFrame(
    val reason: String,
) : WsServerFrame

@Serializable
@SerialName("callResult")
data class CallResultFrame(
    val callId: String,
    val ok: Boolean,
    val result: JsonElement? = null,
    val error: CallErrorBody? = null,
) : WsServerFrame

@Serializable
data class CallErrorBody(
    val message: String,
    val code: String? = null,
)

@Serializable
@SerialName("event")
data class EventFrame(
    val event: String,
    val payload: JsonElement,
    /**
     * Routing-origin meta stamped by the desktop's `transport/ws.ts`
     * for surface-bound events (chat stream / caption / chunk / talking
     * animation). `"mobile"` means the originating turn was driven from
     * this phone; absent means a no-surface broadcast — cycle, greeting,
     * notable check-in. The mobile service uses the absent case to gate
     * the optional [io.mio.mobile.secure.MobilePrefs.receiveProactiveReplies]
     * preference.
     */
    val origin: String? = null,
) : WsServerFrame

// ─── Args wrappers for the few methods Phase M-1 actually calls ────────

@Serializable
data class ChatSendArgs(
    val text: String,
    val options: ChatSendOptionsArgs? = null,
)

@Serializable
data class ChatSendOptionsArgs(
    val includeAutoScreenshot: Boolean? = null,
    /** M-3.6 — base64-encoded image manually attached by the user. */
    val manualImage: AttachedImageArgs? = null,
    /**
     * Surface the turn came from. The mobile client always sends
     * `"mobile"` so the desktop attaches the phone's camera + screen
     * as implicit perception instead of an unrelated Windows
     * screenshot. Mirror of `protocol.ts > ChatOrigin`.
     */
    val origin: String? = null,
)

/**
 * Mirror of `desktop/src/shared/protocol.ts > AttachedImage`. `data`
 * is a raw base64 string (no `data:` URL prefix); `mediaType` is one
 * of the four constants the desktop side accepts.
 */
@Serializable
data class AttachedImageArgs(
    val mediaType: String,
    val data: String,
)
