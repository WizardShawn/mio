package io.mio.mobile.service

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Phase M-5.4 — foreground-app intel.
 *
 * Listens for `TYPE_WINDOW_STATE_CHANGED` and reports which app the
 * user has in the foreground. **It reads `event.packageName` ONLY** —
 * the `accessibility_service_config.xml` does not declare
 * `canRetrieveWindowContent`, so window text / content is never
 * accessible to this service. The human-readable label is resolved
 * locally via `PackageManager`; nothing about *what's on screen* is
 * read or sent.
 *
 * Samples are throttled to ≤ 1/s (leading emit + a trailing flush so
 * the final app in a rapid burst is never lost) and handed to
 * [ActiveAppRelay]; `MioForegroundService` forwards them to the
 * desktop as `perception.activeApp` whenever a desktop is connected.
 */
class MioAccessibilityService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())

    private var lastEmitMs = 0L
    private var lastPackage: String? = null
    private var pending: ActiveAppRelay.Sample? = null
    private var flushScheduled = false

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        // Skip our own UI and system chrome (status bar / nav shade
        // expansions fire window-state changes too).
        if (pkg == packageName) return
        if (pkg in IGNORED_PACKAGES) return
        if (pkg == lastPackage) return
        lastPackage = pkg

        val sample = ActiveAppRelay.Sample(
            packageName = pkg,
            activityLabel = resolveLabel(pkg),
            ts = System.currentTimeMillis(),
        )
        throttle(sample)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onInterrupt() {
        // No feedback to interrupt — Mio's accessibility use is
        // observe-only.
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /**
     * Leading-edge throttle with a trailing flush: emit immediately
     * when ≥ 1 s has passed since the last emit, otherwise hold the
     * newest sample and flush it once the window elapses. Guarantees
     * the final app of a rapid switch burst is still reported.
     */
    private fun throttle(sample: ActiveAppRelay.Sample) {
        val now = System.currentTimeMillis()
        val sinceLast = now - lastEmitMs
        if (sinceLast >= MIN_INTERVAL_MS) {
            emit(sample)
            return
        }
        pending = sample
        if (!flushScheduled) {
            flushScheduled = true
            handler.postDelayed({
                flushScheduled = false
                pending?.let { emit(it) }
                pending = null
            }, MIN_INTERVAL_MS - sinceLast)
        }
    }

    private fun emit(sample: ActiveAppRelay.Sample) {
        lastEmitMs = System.currentTimeMillis()
        ActiveAppRelay.publish(sample)
    }

    /** Resolve a package name to its app label; falls back to the package. */
    private fun resolveLabel(pkg: String): String {
        return runCatching {
            val pm = packageManager
            @Suppress("DEPRECATION")
            val info = pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(info).toString()
        }.getOrElse {
            Log.d(TAG, "could not resolve label for $pkg")
            pkg
        }
    }

    companion object {
        private const val TAG = "MioA11yService"
        private const val MIN_INTERVAL_MS = 1_000L
        private val IGNORED_PACKAGES = setOf(
            "com.android.systemui",
            "android",
        )

        /**
         * The live service instance while the OS has it connected;
         * null whenever the user never enabled the accessibility
         * service, or after teardown. The process is shared with
         * [MioForegroundService], so a plain static handle is enough
         * to reach it — no IPC needed.
         */
        @Volatile
        private var instance: MioAccessibilityService? = null

        /**
         * Top-bar "Quit" hook. [disableSelf] drops Mio from the
         * system's enabled-accessibility-services list and tears the
         * service down, so a complete quit leaves nothing observing in
         * the background. No-op when the service was never enabled.
         */
        fun disableIfRunning() {
            val svc = instance ?: return
            runCatching { svc.disableSelf() }
                .onFailure { Log.w(TAG, "disableSelf failed: ${it.message}") }
        }
    }
}
