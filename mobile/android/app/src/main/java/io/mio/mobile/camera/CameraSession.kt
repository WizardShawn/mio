package io.mio.mobile.camera

import android.content.Context
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Phase M-3.5 — on-demand single-frame capture for `perception.upload`.
 *
 * **Why a fresh-bound use case per capture?** CameraX wants a stable
 * use-case binding for the duration of a session, but our perception
 * step is bursty (one frame at a time, gated by a 10–60 second
 * back-cam pull interval). Holding the camera open between captures
 * would waste battery and could conflict with the user opening
 * another camera app (Android grants exclusive access). Binding on
 * each call, snapping a frame, then unbinding is the price we pay
 * for "polite camera-sharing".
 *
 * **Threading.** The CameraX provider must be bound on the main
 * thread; we marshal through `Dispatchers.Main`. JPEG decode/encode
 * happens in CameraX's internal worker; we receive the result on a
 * dedicated executor that posts the bytes back to the caller's
 * coroutine context.
 *
 * **Output spec (per the plan):** JPEG, quality 75, target ≤ 720p.
 * Quality 75 is a reasonable sweet spot for "phone camera shown to a
 * VLM" — the model doesn't get extra mileage out of higher quality,
 * and 720p caps the bytes-per-frame at ~150–250 KB so the binary WS
 * frame stays cheap on shared LAN bandwidth.
 */
class CameraSession(
    private val appContext: Context,
    private val lifecycleOwner: LifecycleOwner,
) {

    /** Camera facing for [captureFrame]. Mirrors `PerceptionFrameKind`. */
    enum class Facing { Back, Front }

    /**
     * Encoded JPEG bytes from a single capture, plus the metadata
     * `perception.upload` needs to ship along.
     */
    data class CapturedFrame(
        val bytes: ByteArray,
        val width: Int,
        val height: Int,
        val mediaType: String,
        val capturedAtEpochMs: Long,
        val facing: Facing,
    ) {
        // ByteArray's identity-based equals/hashCode would make data
        // classes useless for diffing; we don't actually use these but
        // override for forward-compatibility with future change
        // detection.
        override fun equals(other: Any?): Boolean = this === other
        override fun hashCode(): Int = System.identityHashCode(this)
    }

    private val captureExecutor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "mio-camera-capture")
    }

    /**
     * Capture exactly one JPEG frame and return its bytes. The CameraX
     * use case is bound for the duration of the call and unbound on
     * the way out (success or failure).
     */
    suspend fun captureFrame(facing: Facing): CapturedFrame {
        val provider = providerFor(appContext)
        val selector = when (facing) {
            Facing.Back -> CameraSelector.DEFAULT_BACK_CAMERA
            Facing.Front -> CameraSelector.DEFAULT_FRONT_CAMERA
        }
        val imageCapture = buildImageCapture()

        return withContext(Dispatchers.Main) {
            try {
                provider.unbindAll()
                provider.bindToLifecycle(lifecycleOwner, selector, imageCapture)
                suspendCancellableCoroutine { cont ->
                    imageCapture.takePicture(
                        captureExecutor,
                        object : ImageCapture.OnImageCapturedCallback() {
                            override fun onCaptureSuccess(image: ImageProxy) {
                                val captured = runCatching {
                                    val width = image.width
                                    val height = image.height
                                    val bytes = image.toJpegBytes()
                                    CapturedFrame(
                                        bytes = bytes,
                                        width = width,
                                        height = height,
                                        mediaType = "image/jpeg",
                                        capturedAtEpochMs = System.currentTimeMillis(),
                                        facing = facing,
                                    )
                                }.also { image.close() }
                                captured.fold(
                                    onSuccess = { cont.resume(it) },
                                    onFailure = { cont.resumeWithException(it) },
                                )
                            }

                            override fun onError(exception: ImageCaptureException) {
                                Log.w(TAG, "capture failed: ${exception.message}")
                                cont.resumeWithException(exception)
                            }
                        },
                    )
                    cont.invokeOnCancellation {
                        runCatching { provider.unbindAll() }
                    }
                }
            } finally {
                runCatching { provider.unbindAll() }
            }
        }
    }

    private fun buildImageCapture(): ImageCapture {
        val resolution = ResolutionSelector.Builder()
            .setResolutionStrategy(
                ResolutionStrategy(
                    android.util.Size(1280, 720),
                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
                ),
            )
            .build()
        return ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setJpegQuality(JPEG_QUALITY)
            .setResolutionSelector(resolution)
            .build()
    }

    companion object {
        private const val TAG = "CameraSession"
        /** Per the plan: ~75 keeps the JPEG small without visibly muddying VLM input. */
        private const val JPEG_QUALITY = 75

        private suspend fun providerFor(ctx: Context): ProcessCameraProvider {
            val future: ListenableFuture<ProcessCameraProvider> =
                ProcessCameraProvider.getInstance(ctx)
            if (future.isDone) {
                return runCatching { future.get() }
                    .getOrElse { throw it }
            }
            val deferred = CompletableDeferred<ProcessCameraProvider>()
            future.addListener(
                {
                    runCatching { future.get() }
                        .fold(
                            onSuccess = { deferred.complete(it) },
                            onFailure = { deferred.completeExceptionally(it) },
                        )
                },
                Executors.newSingleThreadExecutor(),
            )
            return deferred.await()
        }

        /**
         * Lift the JPEG bytes out of the [ImageProxy].
         *
         * CameraX's JPEG output mode hands us a single Y-plane buffer
         * with the full JPEG file. We don't need to walk planes or
         * deal with YUV. Some devices add a non-zero `pixelStride`
         * to the buffer; defensive copy via the remaining bytes is
         * the simplest robust read.
         */
        private fun ImageProxy.toJpegBytes(): ByteArray {
            val buffer = planes[0].buffer
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)
            return bytes
        }
    }
}
