package io.mio.mobile.service

import android.content.Context
import android.content.Intent

/**
 * M-6.4 / M-6.5 — fan-out of [MioForegroundService.ConnState] (plus an
 * optional `isTalking` flag) to the Quick Settings tile
 * ([MioQuickSettingsTile]) and the home/lock-screen widget
 * ([io.mio.mobile.widget.MioStatusWidget]).
 *
 * We use plain manifest-registered broadcasts on a custom action so
 * both receivers can live in their own files without the service
 * holding direct references. Sticky-broadcast semantics aren't needed
 * because [requestSnapshot] re-emits the current state on demand, e.g.
 * when a tile is added or a widget is first instantiated.
 */
object MioStatusBroadcast {

    /** Custom broadcast action — kept on the package namespace. */
    const val ACTION_STATE = "io.mio.mobile.action.STATUS_STATE"

    /** Pull-style ask the service to re-emit the latest [ACTION_STATE]. */
    const val ACTION_REQUEST_SNAPSHOT = "io.mio.mobile.action.STATUS_REQUEST_SNAPSHOT"

    /** Conn state, one of [MioForegroundService.ConnState] names. */
    const val EXTRA_CONN_STATE = "conn_state"

    /**
     * `true` while the avatar is in the talking animation,
     * `false` while idle. Omitted means "don't change what the
     * receiver previously cached".
     */
    const val EXTRA_IS_TALKING = "is_talking"

    /** Holds the receiver's cached talking flag so partial updates retain it. */
    private val cachedTalking = java.util.concurrent.atomic.AtomicReference<Boolean?>(null)

    fun notifyState(
        context: Context,
        connState: MioForegroundService.ConnState,
        isTalking: Boolean?,
    ) {
        if (isTalking != null) cachedTalking.set(isTalking)
        val effective = isTalking ?: cachedTalking.get()
        val i = Intent(ACTION_STATE).apply {
            setPackage(context.packageName)
            putExtra(EXTRA_CONN_STATE, connState.name)
            if (effective != null) putExtra(EXTRA_IS_TALKING, effective)
        }
        context.sendBroadcast(i)
    }

    /**
     * Used by the tile / widget on first attach. Resolves [context] to
     * the application context so broadcasts route consistently even
     * when called from a `TileService.onStartListening` whose context
     * might be torn down before delivery.
     */
    fun requestSnapshot(context: Context) {
        val i = Intent(ACTION_REQUEST_SNAPSHOT).apply { setPackage(context.packageName) }
        context.sendBroadcast(i)
    }
}
