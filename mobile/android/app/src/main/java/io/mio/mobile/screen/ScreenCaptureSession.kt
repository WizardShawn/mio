package io.mio.mobile.screen

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import kotlin.math.roundToInt

/**
 * Phase M-5.2 — on-demand single-frame screen capture via
 * MediaProjection.
 *
 * The live [MediaProjection] is owned and kept alive by
 * `MioForegroundService` (it survives UI restarts). This class is the
 * per-capture mechanics only: spin up a [VirtualDisplay] backed by an
 * [ImageReader], grab one frame, JPEG-encode it, tear the display
 * back down.
 *
 * **Output spec** mirrors `CameraSession`: JPEG quality 75, longest
 * edge ≤ 1280 px (i.e. ≤ 720p class), so the binary WS frame stays
 * cheap on a shared LAN. The `VirtualDisplay` is created directly at
 * the scaled-down resolution, so MediaProjection does the downscale
 * for us.
 *
 * **Why bind/unbind per capture?** Screen capture is bursty — one
 * frame per agent-driven pull or manual tap. Holding a `VirtualDisplay`
 * open continuously would keep the projection "hot" (a visible privacy
 * indicator on modern Android) for no benefit between captures.
 */
class ScreenCaptureSession(context: Context) {

    private val appContext = context.applicationContext

    /**
     * Encoded JPEG bytes from one screen capture, plus the metadata
     * `perception.upload` ships alongside. Identity-based equality so
     * the `ByteArray` field doesn't break diffing.
     */
    data class ScreenFrame(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val mediaType: String,
        val capturedAtEpochMs: Long,
    ) {
        override fun equals(other: Any?): Boolean = this === other
        override fun hashCode(): Int = System.identityHashCode(this)
    }

    /**
     * Capture exactly one screen frame through [projection]. Returns
     * `null` on any failure — no frame within the deadline, an encode
     * error, a dead projection. Safe to call from any coroutine
     * context; the `ImageReader` callback is serviced on a dedicated
     * background `HandlerThread`.
     */
    suspend fun capture(projection: MediaProjection): ScreenFrame? {
        val metrics = appContext.resources.displayMetrics
        val srcW = metrics.widthPixels
        val srcH = metrics.heightPixels
        if (srcW <= 0 || srcH <= 0) {
            Log.w(TAG, "capture aborted: bad display metrics ${srcW}x$srcH")
            return null
        }
        val dstW: Int
        val dstH: Int
        val longest = maxOf(srcW, srcH)
        if (longest > MAX_EDGE) {
            val scale = MAX_EDGE.toFloat() / longest
            dstW = (srcW * scale).roundToInt().coerceAtLeast(1)
            dstH = (srcH * scale).roundToInt().coerceAtLeast(1)
        } else {
            dstW = srcW
            dstH = srcH
        }

        val thread = HandlerThread("mio-screen-capture").apply { start() }
        val handler = Handler(thread.looper)
        val reader = ImageReader.newInstance(dstW, dstH, PixelFormat.RGBA_8888, 2)
        val deferred = CompletableDeferred<ScreenFrame?>()

        reader.setOnImageAvailableListener({ r ->
            val image = runCatching { r.acquireLatestImage() }.getOrNull()
                ?: return@setOnImageAvailableListener
            if (!deferred.isCompleted) {
                val frame = runCatching { encode(image, dstW, dstH) }
                    .onFailure { Log.w(TAG, "screen frame encode failed: ${it.message}") }
                    .getOrNull()
                if (frame != null) deferred.complete(frame)
            }
            runCatching { image.close() }
        }, handler)

        var virtualDisplay: VirtualDisplay? = null
        return try {
            virtualDisplay = projection.createVirtualDisplay(
                VIRTUAL_DISPLAY_NAME,
                dstW,
                dstH,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.surface,
                null,
                handler,
            )
            withTimeoutOrNull(CAPTURE_TIMEOUT_MS) { deferred.await() }
        } catch (err: Throwable) {
            Log.w(TAG, "screen capture failed: ${err.message}")
            null
        } finally {
            runCatching { virtualDisplay?.release() }
            runCatching { reader.close() }
            thread.quitSafely()
        }
    }

    /**
     * Lift the RGBA_8888 pixels out of an [Image] and JPEG-encode them.
     *
     * `ImageReader` rows are padded to a hardware-friendly stride, so
     * the backing bitmap is a touch wider than `dstW`; we copy into the
     * padded bitmap, then crop to the real width.
     */
    private fun encode(image: Image, dstW: Int, dstH: Int): ScreenFrame {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * dstW
        val bufferWidth = dstW + rowPadding / pixelStride

        val padded = Bitmap.createBitmap(bufferWidth, dstH, Bitmap.Config.ARGB_8888)
        padded.copyPixelsFromBuffer(plane.buffer)
        val bitmap = if (bufferWidth != dstW) {
            Bitmap.createBitmap(padded, 0, 0, dstW, dstH).also { padded.recycle() }
        } else {
            padded
        }

        val baos = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, baos)
        bitmap.recycle()
        return ScreenFrame(
            bytes = baos.toByteArray(),
            width = dstW,
            height = dstH,
            mediaType = "image/jpeg",
            capturedAtEpochMs = System.currentTimeMillis(),
        )
    }

    companion object {
        private const val TAG = "ScreenCaptureSession"

        /** Per the plan: ~75 keeps the JPEG small without muddying VLM input. */
        private const val JPEG_QUALITY = 75

        /** Longest-edge cap — matches `CameraSession`'s 1280×720 target. */
        private const val MAX_EDGE = 1280

        /** A `VirtualDisplay` delivers its first frame in ~100 ms; 3 s is generous. */
        private const val CAPTURE_TIMEOUT_MS = 3_000L

        private const val VIRTUAL_DISPLAY_NAME = "mio-screen"
    }
}
