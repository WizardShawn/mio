package io.mio.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.mio.mobile.R
import io.mio.mobile.net.AgentPrefsPayload
import io.mio.mobile.net.AgentStatusPayload
import kotlinx.coroutines.launch

/**
 * Mobile Agent page — a lean mirror of the desktop's Settings → Agent
 * panel. The desktop owns the autonomous loop; the phone is just a
 * remote control. We deliberately surface only the knobs an operator
 * needs to answer "is auto loop running, and how often?" without
 * making them get to a laptop:
 *
 *  - Enable / disable the loop.
 *  - Interval (minutes) between cycles.
 *  - Pause / resume + run-now actions.
 *  - Current state pill (`idle` / `running` / `paused` / `capped` …).
 *
 * Daily-cost cap, hourly caps, notable-check-in routing, perception
 * mode, etc. stay on the desktop where there's room to explain them.
 */
@Composable
fun AgentScreen(
    initialPrefs: AgentPrefsPayload?,
    status: AgentStatusPayload?,
    onClose: () -> Unit,
    onSavePrefs: suspend (AgentPrefsPayload) -> AgentPrefsPayload?,
    onTogglePause: suspend () -> AgentStatusPayload?,
    onRunNow: suspend () -> Boolean,
) {
    val scope = rememberCoroutineScope()
    // Hold a local mutable copy so the user can edit without each
    // keystroke racing a network round-trip. `Save` flushes; closing
    // without saving silently discards.
    var enabled by remember(initialPrefs) {
        mutableStateOf(initialPrefs?.enabled ?: false)
    }
    var intervalText by remember(initialPrefs) {
        mutableStateOf((initialPrefs?.intervalMinutes ?: 10).toString())
    }
    var busy by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

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
                .verticalScroll(rememberScrollState()),
        ) {
            AgentHeader(onClose = onClose)

            if (initialPrefs == null) {
                Text(
                    text = stringResource(R.string.agent_loading),
                    color = Color(0xFF9AA3B2),
                    fontSize = 13.sp,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp),
                )
                return@Column
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                AgentCard(title = stringResource(R.string.agent_section_state)) {
                    AgentStateRow(status = status)
                    Spacer(Modifier.height(8.dp))
                    HorizontalDivider(color = Color(0x14FFFFFF))
                    Spacer(Modifier.height(8.dp))
                    AgentActionRow(
                        title = stringResource(R.string.agent_action_pause),
                        subtitle = stringResource(R.string.agent_action_pause_hint),
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                busy = true
                                val s = onTogglePause()
                                busy = false
                                feedback =
                                    if (s != null) null
                                    else "Couldn't reach the desktop."
                            }
                        },
                    )
                    Spacer(Modifier.height(4.dp))
                    AgentActionRow(
                        title = stringResource(R.string.agent_action_run_now),
                        subtitle = stringResource(R.string.agent_action_run_now_hint),
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                busy = true
                                val ok = onRunNow()
                                busy = false
                                feedback =
                                    if (ok) null else "Couldn't reach the desktop."
                            }
                        },
                    )
                }

                AgentCard(title = stringResource(R.string.agent_section_loop)) {
                    AgentToggleRow(
                        title = stringResource(R.string.agent_enabled),
                        subtitle = stringResource(R.string.agent_enabled_hint),
                        checked = enabled,
                        onCheckedChange = { enabled = it },
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = stringResource(R.string.agent_interval),
                        color = Color(0xFFE9ECF2),
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        text = stringResource(R.string.agent_interval_hint),
                        color = Color(0xFF9AA3B2),
                        fontSize = 12.sp,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = intervalText,
                        onValueChange = { raw ->
                            // Allow only digits — keeps the wire payload sane.
                            intervalText = raw.filter { it.isDigit() }
                        },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedTextColor = Color(0xFFE9ECF2),
                            unfocusedTextColor = Color(0xFFE9ECF2),
                            focusedBorderColor = Color(0xFFFFD07A),
                            unfocusedBorderColor = Color(0x33FFFFFF),
                            cursorColor = Color(0xFFFFD07A),
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(12.dp))
                    TextButton(
                        onClick = {
                            val nextInterval = intervalText.toIntOrNull()?.coerceAtLeast(1) ?: 10
                            val next = initialPrefs.copy(
                                enabled = enabled,
                                intervalMinutes = nextInterval,
                            )
                            scope.launch {
                                busy = true
                                val saved = onSavePrefs(next)
                                busy = false
                                feedback =
                                    if (saved != null) "Saved."
                                    else "Couldn't reach the desktop."
                            }
                        },
                        enabled = !busy,
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    ) {
                        Text(
                            text = stringResource(R.string.agent_save),
                            color = Color(0xFFFFD07A),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    feedback?.let { msg ->
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = msg,
                            color = Color(0xFF9AA3B2),
                            fontSize = 12.sp,
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.agent_footer_hint),
                    color = Color(0xFF9AA3B2),
                    fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun AgentHeader(onClose: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onClose) {
            Icon(
                imageVector = Icons.Filled.ArrowBack,
                contentDescription = stringResource(R.string.agent_back),
                tint = Color(0xFFE9ECF2),
            )
        }
        Text(
            text = stringResource(R.string.agent_title),
            color = Color(0xFFE9ECF2),
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun AgentCard(title: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xCC1B1F29), RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(
            text = title,
            color = Color(0xFFFFD07A),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(bottom = 12.dp),
        )
        content()
    }
}

@Composable
private fun AgentStateRow(status: AgentStatusPayload?) {
    val (label, tint) = when (status?.state) {
        "running" -> stringResource(R.string.agent_state_running) to Color(0xFF6DD8A7)
        "idle" -> stringResource(R.string.agent_state_idle) to Color(0xFFB6BFD0)
        "paused" -> stringResource(R.string.agent_state_paused) to Color(0xFFFFD07A)
        "capped" -> stringResource(R.string.agent_state_capped) to Color(0xFFFF8A8A)
        "error" -> stringResource(R.string.agent_state_error) to Color(0xFFFF8A8A)
        "disabled" -> stringResource(R.string.agent_state_disabled) to Color(0xFF9AA3B2)
        else -> stringResource(R.string.agent_state_unknown) to Color(0xFF9AA3B2)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Box(
            modifier = Modifier
                .width(10.dp)
                .height(10.dp)
                .background(tint, RoundedCornerShape(5.dp)),
        )
        Spacer(Modifier.width(10.dp))
        Text(
            text = label,
            color = Color(0xFFE9ECF2),
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
        )
    }
    val reason = status?.reason
    if (!reason.isNullOrBlank()) {
        Spacer(Modifier.height(4.dp))
        Text(
            text = reason,
            color = Color(0xFF9AA3B2),
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun AgentToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = Color(0xFFE9ECF2),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                color = Color(0xFF9AA3B2),
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color(0xFF1B1F29),
                checkedTrackColor = Color(0xFFFFD07A),
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = Color(0xFFE9ECF2),
                uncheckedTrackColor = Color(0xFF2A3140),
                uncheckedBorderColor = Color.Transparent,
            ),
        )
    }
}

@Composable
private fun AgentActionRow(
    title: String,
    subtitle: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = Color(0xFFE9ECF2),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                color = Color(0xFF9AA3B2),
                fontSize = 12.sp,
            )
        }
        TextButton(
            onClick = onClick,
            enabled = enabled,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Text(
                text = stringResource(R.string.agent_action_run),
                color = Color(0xFFFFD07A),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}
