package io.mio.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.size
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
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.mio.mobile.R
import io.mio.mobile.secure.MobilePrefs

/**
 * M-2.8 — mobile-side settings sheet. Deliberately narrower than the
 * desktop's Settings page: most knobs (API keys, model selection,
 * agent loop tunables, voices, persona) belong on the desktop where
 * the brain runs. The phone owns only what's specific to the phone
 * surface: gesture interactions (a thin mirror of the desktop's
 * `gesturePrefs` so the user can toggle them from either side),
 * mobile-only UX (haptics, swipe-up shortcut), and quick links to
 * the OEM battery-guide + unpair flows that used to live in the
 * top-bar.
 *
 * Layout matches [BatteryGuideScreen] — full-screen `Box` with the
 * Mio gradient background, a back-arrow header, then a vertically-
 * scrolling stack of cards. Each card stays one self-contained
 * concern: easy to extend with future flavors of mobile-only knob
 * (battery saver hint, "always show captions", etc.) without
 * touching the rest.
 */
@Composable
fun SettingsScreen(
    state: SettingsState,
    onClose: () -> Unit,
    onToggleGesturesEnabled: (Boolean) -> Unit,
    onToggleHaptics: (Boolean) -> Unit,
    onToggleSwipeUpHistory: (Boolean) -> Unit,
    onSetVoiceLanguage: (String) -> Unit,
    onToggleReceiveProactive: (Boolean) -> Unit,
    onToggleVoiceReplies: (Boolean) -> Unit,
    onToggleCameraAuto: (Boolean) -> Unit,
    onToggleScreenAuto: (Boolean) -> Unit,
    onToggleOverlay: (Boolean) -> Unit,
    onRequestOverlayPermission: () -> Unit,
    onRequestCameraPermission: () -> Unit,
    onRequestScreenCapture: () -> Unit,
    onOpenBatteryGuide: () -> Unit,
    onUnpair: () -> Unit,
) {
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
            SettingsHeader(onClose = onClose)

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                SettingsCard(title = stringResource(R.string.settings_section_touch)) {
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_gestures_enabled),
                        subtitle = stringResource(R.string.settings_gestures_enabled_hint),
                        checked = state.gesturesEnabled,
                        onCheckedChange = onToggleGesturesEnabled,
                    )
                    Spacer(Modifier.height(4.dp))
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_haptics),
                        subtitle = stringResource(R.string.settings_haptics_hint),
                        checked = state.hapticsEnabled,
                        onCheckedChange = onToggleHaptics,
                    )
                    Spacer(Modifier.height(4.dp))
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_swipe_up_history),
                        subtitle = stringResource(R.string.settings_swipe_up_history_hint),
                        checked = state.swipeUpHistoryEnabled,
                        onCheckedChange = onToggleSwipeUpHistory,
                    )
                }

                SettingsCard(title = stringResource(R.string.settings_section_voice)) {
                    SettingsLanguageRow(
                        selected = state.voiceLanguage,
                        onSelect = onSetVoiceLanguage,
                    )
                }

                // Issue-2 — mobile-side filters that decouple this phone
                // from desktop-driven defaults. The desktop's agent loop
                // (cycle interval, daily cost cap, hourly cycle cap)
                // governs WHEN Mio thinks; these toggles govern whether
                // this phone hears the result.
                SettingsCard(title = stringResource(R.string.settings_section_auto)) {
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_receive_proactive),
                        subtitle = stringResource(R.string.settings_receive_proactive_hint),
                        checked = state.receiveProactiveReplies,
                        onCheckedChange = onToggleReceiveProactive,
                    )
                    Spacer(Modifier.height(4.dp))
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_voice_replies),
                        subtitle = stringResource(R.string.settings_voice_replies_hint),
                        checked = state.voiceRepliesEnabled,
                        onCheckedChange = onToggleVoiceReplies,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.settings_auto_desktop_hint),
                        color = Color(0xFF9AA3B2),
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }

                // Mio's autonomous-perception gates. Off blocks Mio's
                // background loop from pulling the matching frame; the
                // manual capture buttons in the chat bar still work
                // and still get sent + persisted as user-attached
                // images.
                //
                // Flipping a toggle ON eagerly requests the matching
                // Android permission (CAMERA runtime grant / MediaProjection
                // consent) — without that the autonomous pulls would
                // be silently dropped service-side, leaving the user
                // staring at an "on" toggle that does nothing.
                SettingsCard(title = stringResource(R.string.settings_section_perception)) {
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_camera_auto),
                        subtitle = stringResource(R.string.settings_camera_auto_hint),
                        checked = state.cameraAutoEnabled,
                        onCheckedChange = { value ->
                            onToggleCameraAuto(value)
                            if (value && !state.cameraPermissionGranted) {
                                onRequestCameraPermission()
                            }
                        },
                    )
                    if (state.cameraAutoEnabled && !state.cameraPermissionGranted) {
                        Spacer(Modifier.height(6.dp))
                        SettingsActionRow(
                            title = stringResource(R.string.settings_camera_auto_grant),
                            subtitle = stringResource(R.string.settings_camera_auto_grant_hint),
                            onClick = onRequestCameraPermission,
                        )
                    }
                    Spacer(Modifier.height(4.dp))
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_screen_auto),
                        subtitle = stringResource(R.string.settings_screen_auto_hint),
                        checked = state.screenAutoEnabled,
                        onCheckedChange = { value ->
                            onToggleScreenAuto(value)
                            if (value && !state.screenProjectionAvailable) {
                                onRequestScreenCapture()
                            }
                        },
                    )
                    if (state.screenAutoEnabled && !state.screenProjectionAvailable) {
                        Spacer(Modifier.height(6.dp))
                        SettingsActionRow(
                            title = stringResource(R.string.settings_screen_auto_grant),
                            subtitle = stringResource(R.string.settings_screen_auto_grant_hint),
                            onClick = onRequestScreenCapture,
                        )
                    }
                }

                // M-10 — background overlay (floating bubble + bottom
                // chat dock). The toggle drives BOTH whether to paint
                // the overlay and whether to prompt for
                // SYSTEM_ALERT_WINDOW the next time the activity goes
                // background.
                SettingsCard(title = stringResource(R.string.settings_section_overlay)) {
                    SettingsToggleRow(
                        title = stringResource(R.string.settings_overlay_enabled),
                        subtitle = stringResource(R.string.settings_overlay_enabled_hint),
                        checked = state.overlayEnabled,
                        onCheckedChange = { value ->
                            onToggleOverlay(value)
                            if (value && !state.overlayPermissionGranted) {
                                onRequestOverlayPermission()
                            }
                        },
                    )
                    if (state.overlayEnabled && !state.overlayPermissionGranted) {
                        Spacer(Modifier.height(6.dp))
                        SettingsActionRow(
                            title = stringResource(R.string.settings_overlay_grant),
                            subtitle = stringResource(R.string.settings_overlay_grant_hint),
                            onClick = onRequestOverlayPermission,
                        )
                    }
                }

                // M-8 — the "How to touch the avatar" reference moved
                // out of this sheet into its own top-bar entry (info
                // icon) so the settings list stays a compact stack of
                // toggles + device actions. See [GestureGuideScreen].

                SettingsCard(title = stringResource(R.string.settings_section_device)) {
                    SettingsActionRow(
                        title = stringResource(R.string.settings_battery_guide),
                        subtitle = stringResource(R.string.settings_battery_guide_hint),
                        onClick = onOpenBatteryGuide,
                    )
                    Spacer(Modifier.height(4.dp))
                    HorizontalDivider(color = Color(0x14FFFFFF))
                    Spacer(Modifier.height(4.dp))
                    SettingsActionRow(
                        title = stringResource(R.string.settings_unpair),
                        subtitle = stringResource(R.string.settings_unpair_hint),
                        onClick = onUnpair,
                        accent = Color(0xFFFF8A8A),
                    )
                }

                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.settings_footer_hint),
                    color = Color(0xFF9AA3B2),
                    fontSize = 11.sp,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp),
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

/**
 * Snapshot of every value the settings sheet renders. Collected from
 * the service's [io.mio.mobile.secure.MobilePrefs] + the cached
 * `gesturePrefs` in [io.mio.mobile.service.MioForegroundService] by
 * the host composable, so this screen can stay a pure function of
 * its inputs.
 */
data class SettingsState(
    val gesturesEnabled: Boolean,
    val hapticsEnabled: Boolean,
    val swipeUpHistoryEnabled: Boolean,
    /** BCP-47 STT tag — [MobilePrefs.VOICE_LANG_EN] / [MobilePrefs.VOICE_LANG_ZH]. */
    val voiceLanguage: String,
    /** Issue-2 — accept the agent loop's no-origin auto check-ins on this phone. */
    val receiveProactiveReplies: Boolean,
    /** Issue-2 — play Mio's TTS chunks through this phone's speakers. */
    val voiceRepliesEnabled: Boolean,
    /** Mio's autonomous perception is allowed to glance through the phone camera. */
    val cameraAutoEnabled: Boolean,
    /**
     * Whether the CAMERA runtime permission has been granted. The
     * `cameraAutoEnabled` toggle is functionally a no-op without it
     * (service-side gate at [io.mio.mobile.service.MioForegroundService.handleCameraPerceptionRequest]
     * silently drops the request); we surface this so the sheet can
     * eagerly prompt + show a CTA if the user toggles ON without
     * a grant.
     */
    val cameraPermissionGranted: Boolean,
    /** Mio's autonomous perception is allowed to read this phone's screen. */
    val screenAutoEnabled: Boolean,
    /**
     * Whether a live MediaProjection is held by the service. Required
     * for autonomous screen captures to actually fire (see
     * [io.mio.mobile.service.MioForegroundService.handleScreenPerceptionRequest]).
     * Mirrors the "auto-prompt + CTA" pattern of [cameraPermissionGranted].
     */
    val screenProjectionAvailable: Boolean,
    /** M-10 — paint a floating bubble + chat dock when the app is backgrounded. */
    val overlayEnabled: Boolean,
    /** Whether SYSTEM_ALERT_WINDOW has been granted; drives the "Grant" CTA. */
    val overlayPermissionGranted: Boolean,
)

@Composable
private fun SettingsHeader(onClose: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onClose) {
            Icon(
                imageVector = Icons.Filled.ArrowBack,
                contentDescription = stringResource(R.string.settings_back),
                tint = Color(0xFFE9ECF2),
            )
        }
        Text(
            text = stringResource(R.string.settings_title),
            color = Color(0xFFE9ECF2),
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun SettingsCard(
    title: String,
    content: @Composable () -> Unit,
) {
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
private fun SettingsToggleRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean = true,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                color = if (enabled) Color(0xFFE9ECF2) else Color(0x809AA3B2),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = subtitle,
                color = if (enabled) Color(0xFF9AA3B2) else Color(0x609AA3B2),
                fontSize = 12.sp,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color(0xFF1B1F29),
                checkedTrackColor = Color(0xFFFFD07A),
                checkedBorderColor = Color.Transparent,
                uncheckedThumbColor = Color(0xFFE9ECF2),
                uncheckedTrackColor = Color(0xFF2A3140),
                uncheckedBorderColor = Color.Transparent,
                disabledCheckedTrackColor = Color(0x33FFD07A),
                disabledUncheckedTrackColor = Color(0x202A3140),
            ),
        )
    }
}

@Composable
private fun SettingsActionRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    accent: Color = Color(0xFFFFD07A),
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
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
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
        ) {
            Text(
                text = stringResource(R.string.settings_open_action),
                color = accent,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Voice-input language picker — a two-segment pill (English / 中文).
 * Android's `SpeechRecognizer` transcribes one language per session,
 * so this is an explicit pick rather than auto-detection: picking the
 * language the user actually speaks keeps recognition accuracy high.
 */
@Composable
private fun SettingsLanguageRow(
    selected: String,
    onSelect: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
    ) {
        Text(
            text = stringResource(R.string.settings_voice_language),
            color = Color(0xFFE9ECF2),
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = stringResource(R.string.settings_voice_language_hint),
            color = Color(0xFF9AA3B2),
            fontSize = 12.sp,
        )
        Spacer(Modifier.height(10.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF2A3140), RoundedCornerShape(12.dp))
                .padding(3.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            VoiceLangSegment(
                label = stringResource(R.string.settings_voice_language_en),
                selected = selected == MobilePrefs.VOICE_LANG_EN,
                onClick = { onSelect(MobilePrefs.VOICE_LANG_EN) },
                modifier = Modifier.weight(1f),
            )
            VoiceLangSegment(
                label = stringResource(R.string.settings_voice_language_zh),
                selected = selected == MobilePrefs.VOICE_LANG_ZH,
                onClick = { onSelect(MobilePrefs.VOICE_LANG_ZH) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun VoiceLangSegment(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .background(
                if (selected) Color(0xFFFFD07A) else Color.Transparent,
                RoundedCornerShape(10.dp),
            )
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) Color(0xFF1B1F29) else Color(0xFFE9ECF2),
            fontSize = 14.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

// M-8 — `GestureGuideCard` (and its supporting helpers) moved to
// [GestureGuideScreen]. Kept this comment as a breadcrumb so anyone
// looking for "how to touch the avatar" lands in the right file.
