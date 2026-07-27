package io.mio.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.mio.mobile.R

/**
 * M-8 — standalone "How to touch the avatar" page.
 *
 * Used to live as a card inside [SettingsScreen] (`GestureGuideCard`),
 * but the M-8 aesthetic refresh promoted it to its own top-bar entry
 * with a dedicated info icon. The settings sheet stays a tight stack
 * of toggles + device actions; the gesture verbs — the longest block
 * of static reference text in the app — gets the full-screen real
 * estate it deserves.
 *
 * Layout mirrors [BatteryGuideScreen] / [SettingsScreen]: full-screen
 * `Box` with the Mio gradient background, a back-arrow header, then a
 * vertically-scrolling stack of rows. Each row uses the same little
 * gold dot leading indicator as the old card so the visual language
 * stays consistent across the app.
 */
@Composable
fun GestureGuideScreen(onClose: () -> Unit) {
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
            GestureGuideHeader(onClose = onClose)

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = stringResource(R.string.settings_guide_intro),
                    color = Color(0xFFB8C4D9),
                    fontSize = 13.sp,
                    modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
                )

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xCC1B1F29), RoundedCornerShape(20.dp))
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                ) {
                    for (entry in GUIDE_VERBS) {
                        GestureGuideRow(
                            titleRes = entry.titleRes,
                            bodyRes = entry.bodyRes,
                        )
                    }
                    HorizontalDivider(
                        color = Color(0x14FFFFFF),
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                    GestureGuideRow(
                        titleRes = R.string.settings_guide_swipe_title,
                        bodyRes = R.string.settings_guide_swipe_body,
                    )
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun GestureGuideHeader(onClose: () -> Unit) {
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
            text = stringResource(R.string.gesture_guide_title),
            color = Color(0xFFE9ECF2),
            fontSize = 20.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun GestureGuideRow(
    titleRes: Int,
    bodyRes: Int,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 7.dp, end = 12.dp)
                .size(8.dp)
                .background(Color(0xFFFFD07A), CircleShape),
        )
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = stringResource(titleRes),
                color = Color(0xFFE9ECF2),
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = stringResource(bodyRes),
                color = Color(0xFFB8C4D9),
                fontSize = 13.sp,
            )
        }
    }
}

private data class GuideVerbEntry(val titleRes: Int, val bodyRes: Int)

private val GUIDE_VERBS = listOf(
    GuideVerbEntry(R.string.settings_guide_poke_title, R.string.settings_guide_poke_body),
    GuideVerbEntry(R.string.settings_guide_pat_title, R.string.settings_guide_pat_body),
    GuideVerbEntry(R.string.settings_guide_caress_title, R.string.settings_guide_caress_body),
    GuideVerbEntry(R.string.settings_guide_stroke_title, R.string.settings_guide_stroke_body),
    GuideVerbEntry(R.string.settings_guide_tickle_title, R.string.settings_guide_tickle_body),
    GuideVerbEntry(R.string.settings_guide_grab_title, R.string.settings_guide_grab_body),
    GuideVerbEntry(R.string.settings_guide_tug_title, R.string.settings_guide_tug_body),
    GuideVerbEntry(R.string.settings_guide_pinch_title, R.string.settings_guide_pinch_body),
)
