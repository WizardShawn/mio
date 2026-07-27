package io.mio.mobile.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import io.mio.mobile.R

/**
 * M-7.2 — OEM battery-optimization explainer. The §5 risk register
 * flags "OEM battery saver kills foreground service" as the top
 * mobile-side risk; this screen is the user-facing mitigation. It
 * branches on `Build.MANUFACTURER` to render the right "go here in
 * Settings" steps, plus a primary CTA that opens the standard Android
 * battery-optimization dialog.
 *
 * Surfaces:
 *   - Primary CTA → `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
 *     with our package URI; works on every device but is mandatory on
 *     stock Android.
 *   - Secondary CTA → OEM-specific settings activity (where one
 *     exists). Falls back to the generic battery-saver settings page.
 */
@Composable
fun BatteryGuideScreen(onClose: () -> Unit) {
    val context = LocalContext.current
    val oem = remember { OemBattery.detect() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MioBackgroundGradient),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp, vertical = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.battery_guide_title),
                color = Color(0xFFE9ECF2),
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = stringResource(R.string.battery_guide_intro),
                color = Color(0xFFB8C4D9),
                fontSize = 14.sp,
            )

            GuideCard(
                title = stringResource(R.string.battery_guide_step_ignore_optimizations),
                body = stringResource(R.string.battery_guide_step_ignore_optimizations_body),
            ) {
                Button(
                    onClick = { OemBattery.openIgnoreOptimizations(context) },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFFD07A)),
                ) {
                    Text(
                        stringResource(R.string.battery_guide_button_ignore_optimizations),
                        color = Color(0xFF1B1F29),
                    )
                }
            }

            GuideCard(
                title = stringResource(oem.titleRes),
                body = stringResource(oem.bodyRes),
            ) {
                if (oem.openOemSettings != null) {
                    OutlinedButton(onClick = { oem.openOemSettings.invoke(context) }) {
                        Text(
                            stringResource(R.string.battery_guide_open_oem),
                            color = Color(0xFFE9ECF2),
                        )
                    }
                }
            }

            Spacer(Modifier.size(8.dp))
            TextButton(
                onClick = onClose,
                modifier = Modifier.align(Alignment.End),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Text(stringResource(R.string.battery_guide_close), color = Color(0xFFB8C4D9))
            }
        }
    }
}

@Composable
private fun GuideCard(
    title: String,
    body: String,
    action: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xCC1B1F29), RoundedCornerShape(14.dp))
            .padding(16.dp)
            .heightIn(min = 96.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(text = title, color = Color(0xFFE9ECF2), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Text(text = body, color = Color(0xFFB8C4D9), fontSize = 13.sp)
        action()
    }
}

/**
 * OEM detection + Settings-page launchers. Each branch wraps the
 * Settings activity the OEM ships for app-protection / autostart. We
 * `try` every intent so a missing Settings activity (firmware variant
 * differences) silently falls back to the generic battery-saver page
 * instead of crashing.
 */
private object OemBattery {
    data class Profile(
        val titleRes: Int,
        val bodyRes: Int,
        val openOemSettings: ((Context) -> Unit)?,
    )

    fun detect(): Profile {
        val mfr = Build.MANUFACTURER.lowercase()
        return when {
            mfr.contains("xiaomi") || mfr.contains("redmi") || mfr.contains("poco") -> Profile(
                titleRes = R.string.battery_guide_oem_xiaomi,
                bodyRes = R.string.battery_guide_oem_xiaomi_body,
                openOemSettings = ::openXiaomiAutostart,
            )
            mfr.contains("samsung") -> Profile(
                titleRes = R.string.battery_guide_oem_samsung,
                bodyRes = R.string.battery_guide_oem_samsung_body,
                openOemSettings = ::openGenericBattery,
            )
            mfr.contains("huawei") || mfr.contains("honor") -> Profile(
                titleRes = R.string.battery_guide_oem_huawei,
                bodyRes = R.string.battery_guide_oem_huawei_body,
                openOemSettings = ::openHuaweiAutostart,
            )
            mfr.contains("oppo") || mfr.contains("oneplus") || mfr.contains("realme") -> Profile(
                titleRes = R.string.battery_guide_oem_oppo,
                bodyRes = R.string.battery_guide_oem_oppo_body,
                openOemSettings = ::openOppoBattery,
            )
            mfr.contains("vivo") || mfr.contains("iqoo") -> Profile(
                titleRes = R.string.battery_guide_oem_vivo,
                bodyRes = R.string.battery_guide_oem_vivo_body,
                openOemSettings = ::openVivoAutostart,
            )
            else -> Profile(
                titleRes = R.string.battery_guide_oem_generic,
                bodyRes = R.string.battery_guide_oem_generic_body,
                openOemSettings = null,
            )
        }
    }

    /**
     * Primary CTA. Opens Android's standard "ask to ignore battery
     * optimizations" dialog, scoped to our package. Works on every
     * Android since 23.
     */
    fun openIgnoreOptimizations(context: Context) {
        val launches = listOf(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = ("package:" + context.packageName).toUri()
            },
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        )
        runFirstWorking(context, launches)
    }

    private fun openGenericBattery(context: Context) {
        runFirstWorking(
            context,
            listOf(
                Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS),
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", context.packageName, null)
                },
            ),
        )
    }

    private fun openXiaomiAutostart(context: Context) {
        runFirstWorking(
            context,
            listOf(
                Intent().setClassName(
                    "com.miui.securitycenter",
                    "com.miui.permcenter.autostart.AutoStartManagementActivity",
                ),
                Intent().setClassName(
                    "com.miui.powerkeeper",
                    "com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
                ),
            ),
        ) { openGenericBattery(context) }
    }

    private fun openHuaweiAutostart(context: Context) {
        runFirstWorking(
            context,
            listOf(
                Intent().setClassName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
                ),
                Intent().setClassName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.optimize.process.ProtectActivity",
                ),
            ),
        ) { openGenericBattery(context) }
    }

    private fun openOppoBattery(context: Context) {
        runFirstWorking(
            context,
            listOf(
                Intent().setClassName(
                    "com.coloros.safecenter",
                    "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                ),
                Intent().setClassName(
                    "com.oppo.safe",
                    "com.oppo.safe.permission.startup.StartupAppListActivity",
                ),
            ),
        ) { openGenericBattery(context) }
    }

    private fun openVivoAutostart(context: Context) {
        runFirstWorking(
            context,
            listOf(
                Intent().setClassName(
                    "com.iqoo.secure",
                    "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
                ),
                Intent().setClassName(
                    "com.vivo.permissionmanager",
                    "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                ),
            ),
        ) { openGenericBattery(context) }
    }

    private fun runFirstWorking(
        context: Context,
        intents: List<Intent>,
        onAllFailed: () -> Unit = {},
    ) {
        for (raw in intents) {
            val intent = Intent(raw).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val resolved = intent.resolveActivity(context.packageManager) != null
            if (!resolved) continue
            runCatching { context.startActivity(intent) }
                .onSuccess { return }
        }
        onAllFailed()
    }
}
