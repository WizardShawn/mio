package io.mio.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Phase M-1 theme. Mirrors the desktop's settings palette
 * (`desktop/src/renderer/settings/style.css`) so phone + desktop look
 * unmistakably like the same app. Material 3 dark scheme only —
 * a light scheme can land at Phase M-7 polish.
 */
private val MioBg = Color(0xFF12141B)
private val MioSurface = Color(0xFF1B1F29)
private val MioText = Color(0xFFE9ECF2)
private val MioTextDim = Color(0xFF9AA3B2)
private val MioAccent = Color(0xFFFFD07A)
private val MioError = Color(0xFFFF8A8A)

private val MioColorScheme = darkColorScheme(
    primary = MioAccent,
    onPrimary = MioBg,
    secondary = MioAccent,
    onSecondary = MioBg,
    background = MioBg,
    onBackground = MioText,
    surface = MioSurface,
    onSurface = MioText,
    surfaceVariant = MioSurface,
    onSurfaceVariant = MioTextDim,
    error = MioError,
    onError = MioBg,
    outline = Color(0x14FFFFFF),
)

@Composable
fun MioTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(colorScheme = MioColorScheme, content = content)
}
