package io.mio.mobile.service

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * M-5.4 — in-process channel from [MioAccessibilityService] to
 * [MioForegroundService].
 *
 * The accessibility service is its own Android component but runs in
 * the same process. Rather than bind the two services together,
 * foreground-app changes are published here; the foreground service
 * collects them and ships `perception.activeApp` over the WS whenever
 * a desktop is connected.
 *
 * `replay = 1` so the foreground service picks up the latest sample
 * even when it starts collecting slightly after the accessibility
 * service's first emit (e.g. after a service restart).
 */
object ActiveAppRelay {
    /**
     * One foreground-app observation. `activityLabel` is the
     * human-readable app name resolved on-device; the accessibility
     * service reads the package name ONLY — never window content.
     */
    data class Sample(
        val packageName: String,
        val activityLabel: String,
        /** Capture timestamp (epoch ms). */
        val ts: Long,
    )

    private val _samples = MutableSharedFlow<Sample>(
        replay = 1,
        extraBufferCapacity = 8,
    )
    val samples: SharedFlow<Sample> = _samples.asSharedFlow()

    fun publish(sample: Sample) {
        _samples.tryEmit(sample)
    }
}
