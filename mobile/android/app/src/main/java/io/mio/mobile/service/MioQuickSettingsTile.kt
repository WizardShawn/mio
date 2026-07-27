package io.mio.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import io.mio.mobile.MainActivity
import io.mio.mobile.R

/**
 * M-6.4 — Quick Settings tile. Mirrors [MioForegroundService.connState]
 * one-way: the service [MioStatusBroadcast.notifyState]s on every
 * transition, and we translate the broadcast into a tile update. Tap
 * collapses the QS panel and opens [MainActivity], same affordance as
 * tapping the sticky foreground-service notification.
 *
 * We deliberately do NOT issue any WS calls from here — the tile is a
 * read-only state surface, the actual chat surface is the activity.
 */
class MioQuickSettingsTile : TileService() {

    private var receiverRegistered = false

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != MioStatusBroadcast.ACTION_STATE) return
            val raw = intent.getStringExtra(MioStatusBroadcast.EXTRA_CONN_STATE) ?: return
            val state = runCatching { MioForegroundService.ConnState.valueOf(raw) }
                .getOrNull() ?: return
            updateTile(state)
        }
    }

    override fun onStartListening() {
        super.onStartListening()
        if (!receiverRegistered) {
            val filter = IntentFilter(MioStatusBroadcast.ACTION_STATE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(stateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag")
                registerReceiver(stateReceiver, filter)
            }
            receiverRegistered = true
        }
        // Pull the latest snapshot from the service; until the
        // broadcast lands we render a neutral "Offline" so the tile
        // doesn't look hung on first open.
        updateTile(MioForegroundService.ConnState.Disconnected)
        runCatching { MioStatusBroadcast.requestSnapshot(applicationContext) }
            .onFailure { Log.w(TAG, "snapshot request failed: ${it.message}") }
    }

    override fun onStopListening() {
        if (receiverRegistered) {
            runCatching { unregisterReceiver(stateReceiver) }
            receiverRegistered = false
        }
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        // Collapse the QS panel and open the chat surface. Same UX as
        // tapping the sticky notification.
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pi = android.app.PendingIntent.getActivity(
                this,
                0,
                intent,
                android.app.PendingIntent.FLAG_IMMUTABLE or
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            startActivityAndCollapse(pi)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun updateTile(state: MioForegroundService.ConnState) {
        val t = qsTile ?: return
        when (state) {
            MioForegroundService.ConnState.Connected -> {
                t.state = Tile.STATE_ACTIVE
                t.label = getString(R.string.qs_tile_label)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    t.subtitle = getString(R.string.qs_tile_subtitle_connected)
                }
            }
            MioForegroundService.ConnState.Unpaired -> {
                t.state = Tile.STATE_INACTIVE
                t.label = getString(R.string.qs_tile_label)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    t.subtitle = getString(R.string.qs_tile_subtitle_unpaired)
                }
            }
            else -> {
                t.state = Tile.STATE_INACTIVE
                t.label = getString(R.string.qs_tile_label)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    t.subtitle = getString(R.string.qs_tile_subtitle_offline)
                }
            }
        }
        runCatching { t.icon = Icon.createWithResource(this, R.drawable.ic_notification) }
        runCatching { t.updateTile() }
            .onFailure { Log.w(TAG, "updateTile failed: ${it.message}") }
    }

    companion object {
        private const val TAG = "MioQsTile"

        /**
         * Best-effort enable hint — Android exposes no programmatic API
         * to pin a tile, but we can at least ensure the component is
         * enabled so it shows up in the QS edit screen on every cold
         * launch. Called from `MioApp` (Application.onCreate) so the
         * tile becomes addable the moment the user installs the APK.
         */
        fun ensureEnabled(context: Context) {
            val pm = context.packageManager
            val cn = android.content.ComponentName(context, MioQuickSettingsTile::class.java)
            pm.setComponentEnabledSetting(
                cn,
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP,
            )
        }
    }
}
