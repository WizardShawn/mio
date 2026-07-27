package io.mio.mobile.avatar

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import io.mio.mobile.secure.MobilePrefs

/**
 * M-2.8 — bridge between the JS gesture controller's `hapticTick`
 * fire-and-forget call and the Android `Vibrator`. Lives at
 * application scope (one instance per process) because it's stateless
 * apart from the cached vibrator handle; reuse keeps us off the
 * `getSystemService` round-trip on every tap.
 *
 * Per-verb patterns:
 *   - poke / pinch: a sharp 12 ms pulse — "you tapped something."
 *   - pat / tickle: two quick 8 ms pulses — "you did that twice."
 *   - caress / stroke: a softer 18 ms pulse — "the long contact landed."
 *   - grab / tug: a stronger 22 ms pulse — "yes, you've got hold of it."
 *
 * Gating: every call consults `MobilePrefs.hapticsEnabled` before
 * touching the vibrator. If the device has no vibrator hardware
 * (some tablets), the helper silently no-ops — Vibrator.hasVibrator()
 * is the gate.
 */
class HapticTicker private constructor(context: Context) {

    private val vibrator: Vibrator? = run {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val mgr = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            mgr?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }
    private val mobilePrefs = MobilePrefs.get(context)

    /**
     * Vibrate for [kind] respecting the user's haptics pref. Safe to
     * call from any thread — `Vibrator.vibrate` is non-blocking and
     * documented as safe from arbitrary callers.
     */
    fun tick(kind: String) {
        if (!mobilePrefs.hapticsEnabled.value) return
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val effect = effectFor(kind) ?: return
        runCatching { v.vibrate(effect) }
    }

    /**
     * Build the per-verb effect. Returns `null` for unknown verbs so a
     * protocol drift doesn't fire an unrelated buzz; the JS side only
     * passes the canonical GestureKind strings today.
     *
     * Amplitudes are scaled against `VibrationEffect.DEFAULT_AMPLITUDE`
     * (255) so a phone whose vibrator can't render an amplitude curve
     * (pre-Oreo, which we don't target anyway, plus a few OEM stubs)
     * still gets a usable on/off pulse.
     */
    private fun effectFor(kind: String): VibrationEffect? {
        return when (kind) {
            "poke", "pinch" -> oneShot(12, 200)
            "pat" -> waveform(longArrayOf(0, 8, 40, 8), intArrayOf(0, 180, 0, 180))
            "tickle" -> waveform(longArrayOf(0, 6, 30, 6, 30, 6), intArrayOf(0, 150, 0, 150, 0, 150))
            "caress" -> oneShot(18, 110)
            "stroke" -> oneShot(18, 130)
            "grab" -> oneShot(22, 230)
            "tug" -> waveform(longArrayOf(0, 14, 50, 22), intArrayOf(0, 180, 0, 220))
            else -> null
        }
    }

    private fun oneShot(durationMs: Long, amplitude: Int): VibrationEffect {
        return VibrationEffect.createOneShot(durationMs, amplitude.coerceIn(1, 255))
    }

    private fun waveform(timings: LongArray, amplitudes: IntArray): VibrationEffect {
        return VibrationEffect.createWaveform(timings, amplitudes, -1)
    }

    companion object {
        @Volatile private var instance: HapticTicker? = null

        fun get(context: Context): HapticTicker =
            instance ?: synchronized(this) {
                instance ?: HapticTicker(context.applicationContext).also { instance = it }
            }
    }
}
