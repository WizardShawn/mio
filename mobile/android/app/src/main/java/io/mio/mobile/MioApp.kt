package io.mio.mobile

import android.app.Application
import io.mio.mobile.service.MioQuickSettingsTile

/**
 * Application singleton. Phase M-1 kept this intentionally empty;
 * Phase M-6 wires it up to nudge the Quick Settings tile component
 * into the enabled bucket on every cold start (so freshly installed
 * APKs show the tile in the QS edit screen without a relaunch).
 *
 * State for the live surfaces still lives in `MioForegroundService`;
 * this class never holds runtime UI/network state.
 */
class MioApp : Application() {
    override fun onCreate() {
        super.onCreate()
        runCatching { MioQuickSettingsTile.ensureEnabled(this) }
    }
}
