package io.mio.mobile.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import io.mio.mobile.MainActivity
import io.mio.mobile.R
import io.mio.mobile.service.MioForegroundService
import io.mio.mobile.service.MioStatusBroadcast

/**
 * M-6.5 — home / lock-screen widget. Renders a tiny "Mio · idle /
 * talking / offline / unpaired" status pill that updates whenever
 * [MioForegroundService] fires its [MioStatusBroadcast]. Tap → open
 * [MainActivity]. The provider is intentionally stateless: latest
 * conn-state + talking flag are stashed in a `SharedPreferences`
 * bucket on every broadcast so a fresh widget instance (added later)
 * can rehydrate its pill without us having to keep state in memory.
 */
class MioStatusWidget : AppWidgetProvider() {

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            MioStatusBroadcast.ACTION_STATE -> {
                val stateRaw = intent.getStringExtra(MioStatusBroadcast.EXTRA_CONN_STATE)
                val state = stateRaw
                    ?.let { runCatching { MioForegroundService.ConnState.valueOf(it) }.getOrNull() }
                    ?: MioForegroundService.ConnState.Disconnected
                val isTalking = if (intent.hasExtra(MioStatusBroadcast.EXTRA_IS_TALKING)) {
                    intent.getBooleanExtra(MioStatusBroadcast.EXTRA_IS_TALKING, false)
                } else {
                    null
                }
                writeCachedState(context, state, isTalking)
                pushUpdateAll(context)
            }
            AppWidgetManager.ACTION_APPWIDGET_UPDATE -> {
                // System-driven update; just re-render from cache and
                // ask the service to re-broadcast in case the user
                // just added the widget.
                pushUpdateAll(context)
                MioStatusBroadcast.requestSnapshot(context)
            }
        }
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val cached = readCachedState(context)
        appWidgetIds.forEach { id ->
            appWidgetManager.updateAppWidget(id, render(context, cached.state, cached.isTalking))
        }
        MioStatusBroadcast.requestSnapshot(context)
    }

    private fun pushUpdateAll(context: Context) {
        val mgr = AppWidgetManager.getInstance(context)
        val cn = ComponentName(context, MioStatusWidget::class.java)
        val ids = mgr.getAppWidgetIds(cn)
        if (ids.isEmpty()) return
        val cached = readCachedState(context)
        val views = render(context, cached.state, cached.isTalking)
        mgr.updateAppWidget(ids, views)
    }

    private fun render(
        context: Context,
        state: MioForegroundService.ConnState,
        isTalking: Boolean?,
    ): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_status)
        views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_label))
        val stateResId = pillResForState(state, isTalking)
        views.setTextViewText(R.id.widget_state, context.getString(stateResId))
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            context,
            0,
            tapIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        views.setOnClickPendingIntent(R.id.widget_root, pi)
        return views
    }

    private fun pillResForState(
        state: MioForegroundService.ConnState,
        isTalking: Boolean?,
    ): Int = when (state) {
        MioForegroundService.ConnState.Connected ->
            if (isTalking == true) R.string.widget_state_talking else R.string.widget_state_idle
        MioForegroundService.ConnState.Connecting -> R.string.widget_state_connecting
        MioForegroundService.ConnState.Unpaired -> R.string.widget_state_unpaired
        MioForegroundService.ConnState.Disconnected,
        MioForegroundService.ConnState.Failed -> R.string.widget_state_offline
    }

    // ─── Cached state ────────────────────────────────────────────────

    private data class CachedState(
        val state: MioForegroundService.ConnState,
        val isTalking: Boolean?,
    )

    private fun readCachedState(context: Context): CachedState {
        val sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = sp.getString(KEY_STATE, null)
        val state = raw
            ?.let { runCatching { MioForegroundService.ConnState.valueOf(it) }.getOrNull() }
            ?: MioForegroundService.ConnState.Unpaired
        val isTalking = if (sp.contains(KEY_TALKING)) sp.getBoolean(KEY_TALKING, false) else null
        return CachedState(state, isTalking)
    }

    private fun writeCachedState(
        context: Context,
        state: MioForegroundService.ConnState,
        isTalking: Boolean?,
    ) {
        val sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val e = sp.edit().putString(KEY_STATE, state.name)
        if (isTalking != null) e.putBoolean(KEY_TALKING, isTalking)
        e.apply()
    }

    companion object {
        private const val PREFS = "mio_widget_state"
        private const val KEY_STATE = "conn_state"
        private const val KEY_TALKING = "is_talking"
    }
}
