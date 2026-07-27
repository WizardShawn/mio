package io.mio.mobile.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import io.mio.mobile.net.ReplyChunkPayload
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Plays the desktop's `chat.replyChunk` audio in arrival order. Each
 * chunk is a single short WAV (Gemini's per-line TTS) served from
 * `http://host:port/asset/audio/<file>`.
 *
 * ## Why this is more than `MediaPlayer.setDataSource(url)`
 *
 * Mio's chunker emits one chunk per Japanese sentence; a normal reply
 * is 3–6 chunks of ~1–2 s each. The naive "create MediaPlayer, point
 * it at the URL, prepareAsync, await completion" loop adds a 200–500
 * ms HTTP fetch + decode gap between every chunk, which the user
 * perceives as stuttering bursts ("on and off like an old radio").
 *
 * We close the gap by **eagerly downloading each chunk** to the app
 * cache directory the moment it lands on the WS, in parallel with any
 * still-in-flight downloads. By the time the playback pump consumes
 * the chunk, the WAV bytes are typically already on disk, so
 * `MediaPlayer` only has the local decode setup to do — a couple of
 * tens of milliseconds at most.
 *
 * Strict-order playback is preserved by a single pump coroutine
 * consuming the channel; concurrency is bounded to the download leg.
 *
 * ## Caption sync (Issue 5)
 *
 *  [onChunkStart] fires the moment each chunk's audio begins playing
 *  through the speaker. The mobile foreground service uses this to
 *  swap the displayed caption to the chunk's matching one-line
 *  `zhText`, mirroring the desktop chat pill's per-segment reveal
 *  instead of dumping the entire translation at once.
 */
class ChunkPlayer(
    private val context: Context,
) {
    private val scopeJob = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + scopeJob)
    private val queue = Channel<QueuedChunk>(Channel.UNLIMITED)
    private var pumpJob: Job? = null

    /**
     * In-flight + completed WAV fetches keyed by absolute audio URL.
     * Populated the moment a chunk is enqueued; consumed by the pump
     * which `await`s the matching deferred before handing the file to
     * `MediaPlayer.setDataSource`. Cleared on barge-in and after each
     * chunk finishes so the cache doesn't grow unbounded.
     */
    private val downloads = ConcurrentHashMap<String, Deferred<File?>>()

    /**
     * Called the moment a chunk's audio starts playing through the
     * speaker. Used by [io.mio.mobile.service.MioForegroundService] to
     * drive the sentence-paced caption.
     */
    var onChunkStart: (ReplyChunkPayload) -> Unit = {}

    private val playerLock = Any()
    private var current: MediaPlayer? = null
    private var currentDone: CompletableDeferred<Unit>? = null

    private val downloadDir: File by lazy {
        File(context.cacheDir, "tts-chunks").apply { mkdirs() }
    }

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private data class QueuedChunk(
        val payload: ReplyChunkPayload,
        val absoluteUrl: String,
    )

    init {
        pumpJob = scope.launch {
            for (chunk in queue) {
                runCatching { playOne(chunk) }
                    .onFailure { Log.w(TAG, "playback failed: ${it.message}") }
            }
        }
    }

    /**
     * Enqueue a chunk. Kicks off the WAV download immediately (in
     * parallel with any others in flight); the actual playback happens
     * inside the pump in arrival order.
     */
    fun enqueue(payload: ReplyChunkPayload) {
        val url = payload.audioUrl ?: return
        downloads.computeIfAbsent(url) { key ->
            scope.async {
                runCatching { downloadChunk(key) }
                    .onFailure { Log.w(TAG, "fetch failed for $key: ${it.message}") }
                    .getOrNull()
            }
        }
        queue.trySend(QueuedChunk(payload = payload, absoluteUrl = url))
    }

    fun reset() {
        while (queue.tryReceive().isSuccess) { /* drop */ }
        downloads.clear()
    }

    /**
     * Barge-in. Stop whatever is playing right now and drop every
     * queued chunk, so Mio falls silent the instant the user starts
     * speaking in voice mode. The next reply's chunks enqueue and
     * play normally; there is no "resume" — a stale, half-played
     * reply is exactly what we want gone.
     */
    fun stopPlayback() {
        synchronized(playerLock) {
            current?.let { mp ->
                runCatching { mp.stop() }
                runCatching { mp.release() }
            }
            current = null
            currentDone?.complete(Unit)
            currentDone = null
        }
        reset()
    }

    fun shutdown() {
        runCatching { queue.close() }
        pumpJob?.cancel()
        scope.cancel()
        synchronized(playerLock) {
            current?.let { runCatching { it.release() } }
            current = null
        }
    }

    private suspend fun playOne(chunk: QueuedChunk) {
        val file = downloads.remove(chunk.absoluteUrl)?.await()
        if (file == null) {
            Log.w(TAG, "no cached file for ${chunk.absoluteUrl} — skipping")
            return
        }

        val done = CompletableDeferred<Unit>()
        val player = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            setOnPreparedListener {
                runCatching { it.start() }
                runCatching { onChunkStart(chunk.payload) }
            }
            setOnCompletionListener {
                runCatching { it.release() }
                done.complete(Unit)
            }
            setOnErrorListener { mp, what, extra ->
                Log.w(TAG, "MediaPlayer error what=$what extra=$extra url=${chunk.absoluteUrl}")
                runCatching { mp.release() }
                done.complete(Unit)
                true
            }
        }
        synchronized(playerLock) {
            current = player
            currentDone = done
        }
        try {
            player.setDataSource(file.absolutePath)
            player.prepareAsync()
            done.await()
        } catch (err: Throwable) {
            Log.w(TAG, "setDataSource failed for ${file.absolutePath}: ${err.message}")
            runCatching { player.release() }
        } finally {
            synchronized(playerLock) {
                if (current === player) {
                    current = null
                    currentDone = null
                }
            }
            runCatching { file.delete() }
        }
    }

    /**
     * Synchronously pull the WAV bytes off the LAN HTTP server and
     * write them to a uniquely-named file under [downloadDir]. The
     * file is deleted in [playOne]'s finally block once playback ends.
     */
    private fun downloadChunk(url: String): File {
        val req = Request.Builder().url(url).build()
        httpClient.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("HTTP ${resp.code} for $url")
            }
            val body = resp.body ?: throw IllegalStateException("no body for $url")
            val out = File(downloadDir, "${System.currentTimeMillis()}-${UUID.randomUUID()}.wav")
            body.byteStream().use { input ->
                out.outputStream().use { output -> input.copyTo(output) }
            }
            return out
        }
    }

    companion object {
        private const val TAG = "ChunkPlayer"
    }
}
