package io.mio.mobile.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.AutoMode
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.Flow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.mio.mobile.R
import io.mio.mobile.avatar.AvatarController
import io.mio.mobile.avatar.AvatarSurface
import io.mio.mobile.camera.CameraSession
import io.mio.mobile.net.AttachedImageArgs
import io.mio.mobile.screen.ScreenCaptureSession
import io.mio.mobile.service.MioForegroundService
import io.mio.mobile.service.MioForegroundService.ConnState
import kotlinx.coroutines.launch

/**
 * Phase M-2.3 chat surface — Grok-Mika style.
 *
 * Layout, back-to-front:
 *   1. Dark vertical gradient (Mio brand 12141B -> 0B0C12).
 *   2. AvatarSurface (transparent WebView) painting Three.js + three-vrm
 *      output over the gradient.
 *   3. Translucent top row: status pill + unpair entry.
 *   4. Translucent bottom column: latest reply caption (faded in) +
 *      chat input row (mic placeholder, camera placeholder, "Ask
 *      anything..." input pill, send icon).
 *   5. Optional history overlay (modal, scrollable LazyColumn) that
 *      slides in when the user taps the caption or the history a11y
 *      affordance; the chat input stays pinned at the bottom so they
 *      can keep talking with history open.
 *
 * Why a Box for the whole screen?
 *   - Avatar sits behind everything else and must `fillMaxSize` without
 *     a Column eating space for it. Stacking with `Alignment` slots is
 *     cleaner than nested Columns with `Modifier.weight`.
 *   - The history overlay slides in over the avatar without disturbing
 *     the existing chat row's recomposition.
 */
@Composable
fun ChatScreen(
    chatLog: List<MioForegroundService.ChatEntry>,
    connState: ConnState,
    avatarController: AvatarController,
    historyExpanded: Boolean,
    onHistoryExpandedChange: (Boolean) -> Unit,
    /**
     * Issue-5 — single-line caption synced to TTS chunk playback.
     * `null` until the first chunk of a reply starts playing; updated
     * by [MioForegroundService.currentChunkCaption] on each chunk
     * boundary; cleared on barge-in / new user turn.
     */
    chunkCaption: String?,
    warningMessages: Flow<String>,
    perceptionBanner: Flow<String>,
    onSend: suspend (String, AttachedImageArgs?) -> Boolean,
    onCaptureCamera: suspend (CameraSession.Facing) -> CameraSession.CapturedFrame?,
    onCaptureScreen: suspend () -> ScreenCaptureSession.ScreenFrame?,
    /**
     * Open the system photo picker (filtered to image/jpeg|png|gif|webp)
     * and return a base64-encoded [AttachedImageArgs], or null on
     * cancel / unsupported pick. Wired by the activity to a
     * GetContent ActivityResultLauncher.
     */
    onPickImage: suspend () -> AttachedImageArgs?,
    /**
     * Open the system file picker filtered to application/pdf and
     * return a base64 [AttachedImageArgs] tagged `application/pdf` —
     * the desktop chat tool routes it through a Claude `document`
     * block.
     */
    onPickPdf: suspend () -> AttachedImageArgs?,
    voiceMode: Boolean,
    voicePartial: String,
    onToggleVoice: () -> Unit,
    /**
     * M-2.8 — opens the mobile [SettingsScreen]. Wired by the host
     * activity to flip a `settingsOpen` state slot; the chat surface
     * stays composed underneath so closing the sheet drops the user
     * back exactly where they were. The previous inline "Battery"
     * and "Forget" entries in the top bar both moved into the
     * settings sheet, so this is now the single top-bar destination
     * for any phone-side knob.
     */
    onOpenSettings: () -> Unit,
    /**
     * M-8 — opens the standalone [GestureGuideScreen] ("How to touch
     * the avatar"). The guide used to live as a card inside the
     * settings sheet, but the M-8 top-bar refresh gave it a dedicated
     * info button so the reference table gets full-screen real estate.
     */
    onOpenInfo: () -> Unit,
    /**
     * Opens the mobile [AgentScreen] — a lean remote for the desktop's
     * autonomous loop. Sits between Info and Settings on the top-right
     * menu so the operator can see/toggle the loop without reaching for
     * a laptop.
     */
    onOpenAgent: () -> Unit,
    /**
     * Fully exits the app. Background components (the foreground
     * service with its ongoing notification, and the accessibility
     * service when enabled) outlive a swiped-away task, so closing the
     * window alone never truly quits; this stops both and finishes the
     * activity. Wired by the host activity — the chat surface only
     * triggers it from the top-bar "Quit" entry.
     */
    onQuit: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var capturing by remember { mutableStateOf(false) }
    // M-3.6 — base64-encoded JPEG (plus raw bytes for the thumbnail
    // preview) currently staged for the *next* `chat.send`. Cleared
    // after a successful send or when the user taps the X on the
    // thumbnail row.
    var attachedImage by remember { mutableStateOf<AttachedImageArgs?>(null) }
    var attachedPreviewBytes by remember { mutableStateOf<ByteArray?>(null) }
    val snackbarHostState = remember { SnackbarHostState() }

    // M-2.6 — when ChatScreen is composed, route the service's
    // warning flow into a Material 3 Snackbar. The service still posts
    // a backup heads-up notification if the process isn't foregrounded
    // when the warning arrives, so this Snackbar is purely the
    // foreground UX.
    LaunchedEffect(warningMessages) {
        warningMessages.collect { msg ->
            snackbarHostState.showSnackbar(
                message = msg,
                actionLabel = null,
                withDismissAction = true,
                duration = SnackbarDuration.Long,
            )
        }
    }

    // M-3.7 — short-lived banner ("Mio glanced through the camera")
    // when the agent loop pulls a frame on its own initiative. We use
    // the same SnackbarHost so the layout stays simple, but with a
    // SHORT duration and the avatar accent colour so the user can
    // distinguish it from a real warning.
    val perceptionSnackbar = remember { SnackbarHostState() }
    LaunchedEffect(perceptionBanner) {
        perceptionBanner.collect { msg ->
            perceptionSnackbar.showSnackbar(
                message = msg,
                actionLabel = null,
                withDismissAction = false,
                duration = SnackbarDuration.Short,
            )
        }
    }

    // Issue-5: prefer the per-chunk sentence (driven by ChunkPlayer's
    // onChunkStart callback) over the full assistant text. The full
    // reply still lives in the history overlay; the bottom pill is
    // now strictly a YouTube-style "one line at a time" caption that
    // tracks the audio Mio is currently speaking. When no chunk has
    // started yet, fall back to the assistant entry's caption / text
    // so the pill isn't blank during the brief gap between user-send
    // and the first chunk landing.
    val latestAssistant = remember(chatLog) {
        chatLog.lastOrNull { it is MioForegroundService.ChatEntry.Assistant } as? MioForegroundService.ChatEntry.Assistant
    }
    val captionText: String? = remember(chunkCaption, latestAssistant) {
        chunkCaption?.takeIf { it.isNotBlank() }
            ?: latestAssistant?.let { a ->
                a.caption?.takeIf { it.isNotBlank() } ?: a.text.takeIf { it.isNotBlank() }
            }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MioChatBackgroundGradient),
    ) {
        AvatarSurface(
            controller = avatarController,
            modifier = Modifier.fillMaxSize(),
        )

        TopRightMenu(
            connState = connState,
            onOpenSettings = onOpenSettings,
            onOpenInfo = onOpenInfo,
            onOpenAgent = onOpenAgent,
            onQuit = onQuit,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(top = 8.dp, end = 12.dp),
        )

        BottomDock(
            captionText = captionText,
            draft = draft,
            sending = sending,
            capturing = capturing,
            attachedPreviewBytes = attachedPreviewBytes,
            hasAttachment = attachedImage != null,
            isPdfAttachment = attachedImage?.mediaType == "application/pdf",
            connected = connState == ConnState.Connected,
            voiceMode = voiceMode,
            voicePartial = voicePartial,
            onDraftChange = { draft = it },
            onCaptionTap = { onHistoryExpandedChange(true) },
            onMic = onToggleVoice,
            onCamera = {
                // M-3.6 — back-camera by default. We don't expose a
                // facing toggle in M-3 to keep the bottom row simple;
                // the agent-driven pull path (M-3.7) can still ask
                // for `front-cam` when the desktop side wires it.
                if (capturing) return@BottomDock
                capturing = true
                scope.launch {
                    val frame = onCaptureCamera(CameraSession.Facing.Back)
                    if (frame != null) {
                        val base64 = Base64.encodeToString(frame.bytes, Base64.NO_WRAP)
                        attachedImage = AttachedImageArgs(
                            mediaType = frame.mediaType,
                            data = base64,
                        )
                        attachedPreviewBytes = frame.bytes
                    }
                    capturing = false
                }
            },
            // Attachment sheet: photo / pdf / screenshot. Each handler
            // stages the picked file as `attachedImage`, mirroring the
            // existing camera-staging behaviour so the user can keep
            // typing before they send.
            onAttachImage = {
                if (capturing) return@BottomDock
                capturing = true
                scope.launch {
                    val picked = onPickImage()
                    if (picked != null) {
                        attachedImage = picked
                        // PDFs don't get a thumbnail (we'd need a PDF
                        // renderer); the attachment row just shows the
                        // file-type chip when bytes are null.
                        attachedPreviewBytes = decodeImagePreviewBytes(picked)
                    }
                    capturing = false
                }
            },
            onAttachPdf = {
                if (capturing) return@BottomDock
                capturing = true
                scope.launch {
                    val picked = onPickPdf()
                    if (picked != null) {
                        attachedImage = picked
                        attachedPreviewBytes = null
                    }
                    capturing = false
                }
            },
            onAttachScreenshot = {
                // M-5.3 — capture the phone screen and stage it as the
                // next message's attachment, exactly like the camera
                // button. `onCaptureScreen` returns null when the
                // projection consent dialog had to be shown first.
                if (capturing) return@BottomDock
                capturing = true
                scope.launch {
                    val frame = onCaptureScreen()
                    if (frame != null) {
                        val base64 = Base64.encodeToString(frame.bytes, Base64.NO_WRAP)
                        attachedImage = AttachedImageArgs(
                            mediaType = frame.mediaType,
                            data = base64,
                        )
                        attachedPreviewBytes = frame.bytes
                    }
                    capturing = false
                }
            },
            onClearAttachment = {
                attachedImage = null
                attachedPreviewBytes = null
            },
            onSend = {
                val text = draft.trim()
                val image = attachedImage
                if ((text.isEmpty() && image == null) || sending) return@BottomDock
                sending = true
                scope.launch {
                    val ok = onSend(text, image)
                    if (ok) {
                        draft = ""
                        attachedImage = null
                        attachedPreviewBytes = null
                    }
                    sending = false
                }
            },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .imePadding(),
        )

        if (historyExpanded) {
            HistoryOverlay(
                chatLog = chatLog,
                onDismiss = { onHistoryExpandedChange(false) },
                modifier = Modifier.fillMaxSize(),
            )
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(bottom = 96.dp, start = 12.dp, end = 12.dp),
        ) { data ->
            Snackbar(
                snackbarData = data,
                containerColor = Color(0xFF3A1F23),
                contentColor = Color(0xFFFFD7DC),
                actionColor = Color(0xFFFFD07A),
            )
        }

        // M-3.7 — perception banner sits closer to the top so it
        // doesn't compete with the warning snackbar or the bottom
        // dock. Tinted with the avatar accent colour to signal "Mio
        // did a thing" vs. the reddish warning palette.
        SnackbarHost(
            hostState = perceptionSnackbar,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 56.dp, start = 12.dp, end = 12.dp),
        ) { data ->
            Snackbar(
                snackbarData = data,
                containerColor = Color(0xCC1B1F29),
                contentColor = Color(0xFFE9ECF2),
                actionColor = Color(0xFFFFD07A),
            )
        }
    }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Top-right collapsible menu (M-8).                                     */
/*                                                                        */
/*  Mimics the Grok-Ani layout: a vertical stack of soft-violet circular  */
/*  buttons in the top-right corner. Collapsed by default — only the      */
/*  icons are visible, plus the expand chevron at the bottom. Tapping     */
/*  the chevron (or any item while collapsed) slides labels in from the   */
/*  left of each row; from there, tapping a labeled row navigates into    */
/*  the corresponding screen (info / settings).                           */
/*                                                                        */
/*  Why "tap to expand" rather than direct-tap navigation? The user       */
/*  explicitly asked for "minimal information by default, only when       */
/*  touch once then shown full information of the menu and then user     */
/*  touch can enter the specific menu page" — a two-step gate that keeps  */
/*  the chrome out of the way while she's just looking at the avatar.    */
/* ────────────────────────────────────────────────────────────────────── */

@Composable
private fun TopRightMenu(
    connState: ConnState,
    onOpenSettings: () -> Unit,
    onOpenInfo: () -> Unit,
    onOpenAgent: () -> Unit,
    onQuit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val (statusLabel, statusTint) = remember(connState) {
        when (connState) {
            // Host:port is deliberately not shown — the row stays a
            // clean "Online" rather than exposing the LAN address.
            ConnState.Connected -> "Online" to Color(0xFF6DD8A7)
            ConnState.Connecting -> "Connecting…" to Color(0xFFFFD07A)
            ConnState.Disconnected, ConnState.Failed -> "Offline" to Color(0xFFFF8A8A)
            ConnState.Unpaired -> "Not paired" to Color(0xFF9AA3B2)
        }
    }

    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Status — informational only. While collapsed it's still a
        // tap target (any tap expands the menu) but it doesn't
        // navigate anywhere when tapped in the expanded state either:
        // its job is just to show the connection state at a glance.
        TopMenuItem(
            label = statusLabel,
            icon = MenuIcon.Dot(statusTint),
            expanded = expanded,
            onClick = { expanded = true },
            contentDescription = statusLabel,
        )
        TopMenuItem(
            label = stringResLocal(R.string.menu_info_label),
            icon = MenuIcon.Vector(Icons.Filled.Info),
            expanded = expanded,
            onClick = {
                if (expanded) onOpenInfo() else expanded = true
            },
            contentDescription = stringResLocal(R.string.menu_info_label),
        )
        TopMenuItem(
            label = stringResLocal(R.string.menu_agent_label),
            icon = MenuIcon.Vector(Icons.Filled.AutoMode),
            expanded = expanded,
            onClick = {
                if (expanded) onOpenAgent() else expanded = true
            },
            contentDescription = stringResLocal(R.string.menu_agent_label),
        )
        TopMenuItem(
            label = stringResLocal(R.string.menu_settings_label),
            icon = MenuIcon.Vector(Icons.Filled.Settings),
            expanded = expanded,
            onClick = {
                if (expanded) onOpenSettings() else expanded = true
            },
            contentDescription = stringResLocal(R.string.chat_a11y_settings),
        )
        // True-quit. Like the info / settings rows it's gated behind
        // the expand step, so a stray tap on the collapsed menu only
        // opens it rather than killing the app. Sits above the chevron
        // so the expand/collapse control stays anchored at the bottom.
        TopMenuItem(
            label = stringResLocal(R.string.menu_quit_label),
            icon = MenuIcon.Vector(Icons.Filled.PowerSettingsNew),
            expanded = expanded,
            onClick = {
                if (expanded) onQuit() else expanded = true
            },
            contentDescription = stringResLocal(R.string.menu_quit_label),
        )
        TopMenuItem(
            label = stringResLocal(
                if (expanded) R.string.menu_close_label else R.string.menu_open_label,
            ),
            icon = MenuIcon.Vector(
                if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
            ),
            expanded = expanded,
            onClick = { expanded = !expanded },
            contentDescription = stringResLocal(
                if (expanded) R.string.menu_close_label else R.string.menu_open_label,
            ),
        )
    }
}

/**
 * Discriminated icon payload for [TopMenuItem]. The status row paints
 * a coloured dot (no vector icon ships a perfect "single solid dot"
 * with controllable colour at small sizes), while every other row
 * paints a regular Material vector icon.
 */
private sealed interface MenuIcon {
    data class Vector(val image: ImageVector) : MenuIcon
    data class Dot(val tint: Color) : MenuIcon
}

@Composable
private fun TopMenuItem(
    label: String,
    icon: MenuIcon,
    expanded: Boolean,
    onClick: () -> Unit,
    contentDescription: String,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.End,
        modifier = Modifier.clickable(onClick = onClick),
    ) {
        AnimatedVisibility(
            visible = expanded,
            enter = fadeIn() + expandHorizontally(expandFrom = Alignment.End),
            exit = fadeOut() + shrinkHorizontally(shrinkTowards = Alignment.End),
        ) {
            Text(
                text = label,
                color = Color(0xFFE9ECF2),
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(end = 10.dp),
            )
        }
        Box(
            modifier = Modifier
                .size(40.dp)
                .background(MioMenuButtonColor, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            when (icon) {
                is MenuIcon.Vector -> Icon(
                    imageVector = icon.image,
                    contentDescription = contentDescription,
                    tint = Color(0xFFE9ECF2),
                    modifier = Modifier.size(20.dp),
                )
                is MenuIcon.Dot -> Box(
                    modifier = Modifier
                        .size(12.dp)
                        .background(icon.tint, CircleShape),
                )
            }
        }
    }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Bottom: caption above input row (mic | camera | input | send).        */
/* ────────────────────────────────────────────────────────────────────── */

@Composable
private fun BottomDock(
    captionText: String?,
    draft: String,
    sending: Boolean,
    capturing: Boolean,
    attachedPreviewBytes: ByteArray?,
    hasAttachment: Boolean,
    isPdfAttachment: Boolean,
    connected: Boolean,
    voiceMode: Boolean,
    voicePartial: String,
    onDraftChange: (String) -> Unit,
    onCaptionTap: () -> Unit,
    onMic: () -> Unit,
    onCamera: () -> Unit,
    /** Three-way attachment sheet: photo / pdf / screenshot. */
    onAttachImage: () -> Unit,
    onAttachPdf: () -> Unit,
    onAttachScreenshot: () -> Unit,
    onClearAttachment: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (captionText != null) {
            CaptionOverlay(text = captionText, onTap = onCaptionTap)
        }
        // The staged-attachment row is hidden in voice mode — voice
        // utterances auto-send and carry no manual image. Showing the
        // row when bytes are null still works for PDFs (the row
        // branches on `attachedImage.mediaType` to show a PDF chip
        // instead of a thumbnail).
        if (hasAttachment && !voiceMode) {
            AttachmentPreviewRow(
                jpegBytes = attachedPreviewBytes,
                isPdf = isPdfAttachment,
                onClear = onClearAttachment,
            )
        }
        InputRow(
            draft = draft,
            sending = sending,
            capturing = capturing,
            hasAttachment = hasAttachment,
            connected = connected,
            voiceMode = voiceMode,
            voicePartial = voicePartial,
            onDraftChange = onDraftChange,
            onMic = onMic,
            onCamera = onCamera,
            onAttachImage = onAttachImage,
            onAttachPdf = onAttachPdf,
            onAttachScreenshot = onAttachScreenshot,
            onSend = onSend,
        )
    }
}

/**
 * M-3.6 — thumbnail preview pinned above the input row whenever the
 * user has captured an image they haven't sent yet. The bitmap is
 * decoded once (keyed on the raw JPEG bytes) so the column-recompose
 * triggered by typing in the input doesn't reflow the decoder.
 *
 * Tap X to discard. The thumbnail itself isn't tappable so the user
 * doesn't accidentally lose a frame they spent a few seconds framing.
 */
@Composable
private fun AttachmentPreviewRow(
    jpegBytes: ByteArray?,
    isPdf: Boolean,
    onClear: () -> Unit,
) {
    val bitmap = remember(jpegBytes) {
        jpegBytes?.let {
            runCatching {
                BitmapFactory.decodeByteArray(it, 0, it.size)
            }.getOrNull()
        }
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color(0xE61B1F29),
        shape = RoundedCornerShape(20.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .background(Color(0xFF0B0C12), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                if (bitmap != null) {
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = stringResLocal(R.string.chat_attachment_preview),
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color(0xFF0B0C12), RoundedCornerShape(12.dp)),
                    )
                } else if (isPdf) {
                    Icon(
                        imageVector = Icons.Filled.PictureAsPdf,
                        contentDescription = null,
                        tint = Color(0xFFFFD07A),
                    )
                } else {
                    Icon(
                        imageVector = Icons.Filled.PhotoCamera,
                        contentDescription = null,
                        tint = Color(0xFF9AA3B2),
                    )
                }
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResLocal(R.string.chat_attachment_title),
                    color = Color(0xFFE9ECF2),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = stringResLocal(R.string.chat_attachment_hint),
                    color = Color(0xFF9AA3B2),
                    fontSize = 11.sp,
                )
            }
            IconButton(onClick = onClear) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = stringResLocal(R.string.chat_attachment_remove),
                    tint = Color(0xFF9AA3B2),
                )
            }
        }
    }
}

/**
 * Issue-5 — single-line caption synced to per-chunk TTS playback.
 *
 * Bounded to 2 visual lines + ellipsis so a long Chinese sentence still
 * fits the pill silhouette without ballooning the bottom dock between
 * chunks. The desktop chat pill enforces the same rolling-subtitle
 * shape via `segmentedCaption.ts > PILL_FIT_CHARS`; on mobile we use
 * the cheaper `maxLines = 2` bound because the chunk boundaries are
 * already sentence-aligned by `replyTts.alignZhToChunks` server-side.
 *
 * A short crossfade on text change keeps successive sentences from
 * snapping in jarringly; the underlying [text] is keyed into
 * `AnimatedContent` so Compose animates the swap.
 */
@Composable
private fun CaptionOverlay(text: String, onTap: () -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap),
        color = Color(0xCC1B1F29),
        shape = RoundedCornerShape(16.dp),
    ) {
        AnimatedContent(
            targetState = text,
            transitionSpec = {
                (fadeIn(animationSpec = tween(180)) togetherWith
                    fadeOut(animationSpec = tween(120)))
                    .using(SizeTransform(clip = false))
            },
            label = "caption-crossfade",
        ) { displayed ->
            Text(
                text = displayed,
                color = Color(0xFFE9ECF2),
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .fillMaxWidth(),
            )
        }
    }
}

/**
 * M-8 — bottom chat row, reshaped to match the Grok-Ani layout:
 *
 *   [Mic ○] [Cam ○]  [ ⊞ Ask anything… ]  [ ↑ Send ]
 *
 * Mic + camera are stand-alone soft-violet circles to the left, the
 * input pill carries a leading screen-share affordance (visual sibling
 * of Grok's paperclip), and the send button is the bright white pill
 * on the right — the only chromatic accent on the dock, so the eye
 * lands on it without thinking.
 *
 * Voice mode swaps the pill + send pill for a single live transcript
 * indicator (utterances auto-send, so a dedicated send is moot).
 */
@Composable
private fun InputRow(
    draft: String,
    sending: Boolean,
    capturing: Boolean,
    hasAttachment: Boolean,
    connected: Boolean,
    voiceMode: Boolean,
    voicePartial: String,
    onDraftChange: (String) -> Unit,
    onMic: () -> Unit,
    onCamera: () -> Unit,
    onAttachImage: () -> Unit,
    onAttachPdf: () -> Unit,
    onAttachScreenshot: () -> Unit,
    onSend: () -> Unit,
) {
    val cameraEnabled = connected && !capturing
    val sendEnabled = connected && !sending && (draft.isNotBlank() || hasAttachment)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // M-4 — the mic toggles voice-input mode. Gold while
        // listening; stays tappable even when disconnected so the
        // user can always leave voice mode.
        CircularDockButton(
            icon = Icons.Filled.Mic,
            contentDescription = stringResLocal(
                if (voiceMode) R.string.chat_a11y_voice_stop
                else R.string.chat_a11y_mic,
            ),
            tint = when {
                voiceMode -> Color(0xFFFFD07A)
                !connected -> Color(0x809AA3B2)
                else -> Color(0xFFE9ECF2)
            },
            enabled = connected || voiceMode,
            onClick = onMic,
        )

        if (voiceMode) {
            // Voice mode collapses the input + send into a single
            // live-listening pill. Utterances auto-send after a pause,
            // so a manual send affordance would be misleading.
            Surface(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
                color = MioInputPillColor,
                shape = RoundedCornerShape(28.dp),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    VoiceListeningIndicator(
                        partial = voicePartial,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        } else {
            // M-3.6 — live camera shortcut. Tinted accent (gold)
            // when a frame is currently attached so the user
            // remembers the next send carries an image; muted
            // otherwise.
            CircularDockButton(
                icon = Icons.Filled.PhotoCamera,
                contentDescription = stringResLocal(R.string.chat_a11y_camera),
                tint = when {
                    !cameraEnabled -> Color(0x809AA3B2)
                    hasAttachment -> Color(0xFFFFD07A)
                    else -> Color(0xFFE9ECF2)
                },
                enabled = cameraEnabled,
                onClick = onCamera,
            )

            // M-8 — center pill. Same dark-violet wash as the menu
            // buttons; the leading icon is now the screen-share
            // shortcut (Grok carries a paperclip there — for us it's
            // the "stage a phone-screen frame" affordance, visually
            // identical and semantically closer to "attach"). Send
            // moved out to its own white pill to the right.
            Surface(
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 48.dp),
                color = MioInputPillColor,
                shape = RoundedCornerShape(28.dp),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 4.dp, vertical = 0.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    var attachMenuOpen by remember { mutableStateOf(false) }
                    Box {
                        IconButton(
                            onClick = { attachMenuOpen = true },
                            enabled = cameraEnabled,
                            modifier = Modifier.size(44.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.AttachFile,
                                contentDescription = stringResLocal(R.string.attachment_a11y),
                                tint = when {
                                    !cameraEnabled -> Color(0x809AA3B2)
                                    hasAttachment -> Color(0xFFFFD07A)
                                    else -> Color(0xFFE9ECF2)
                                },
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        DropdownMenu(
                            expanded = attachMenuOpen,
                            onDismissRequest = { attachMenuOpen = false },
                        ) {
                            DropdownMenuItem(
                                text = { Text(stringResLocal(R.string.attachment_menu_image)) },
                                leadingIcon = {
                                    Icon(Icons.Filled.Image, contentDescription = null)
                                },
                                onClick = {
                                    attachMenuOpen = false
                                    onAttachImage()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResLocal(R.string.attachment_menu_pdf)) },
                                leadingIcon = {
                                    Icon(Icons.Filled.PictureAsPdf, contentDescription = null)
                                },
                                onClick = {
                                    attachMenuOpen = false
                                    onAttachPdf()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResLocal(R.string.attachment_menu_screenshot)) },
                                leadingIcon = {
                                    Icon(Icons.Filled.PhoneAndroid, contentDescription = null)
                                },
                                onClick = {
                                    attachMenuOpen = false
                                    onAttachScreenshot()
                                },
                            )
                        }
                    }
                    OutlinedTextField(
                        value = draft,
                        onValueChange = onDraftChange,
                        placeholder = {
                            Text(
                                text = stringResLocal(R.string.chat_input_hint),
                                color = Color(0xFF9AA3B2),
                                fontSize = 15.sp,
                            )
                        },
                        singleLine = false,
                        maxLines = 4,
                        enabled = connected,
                        textStyle = androidx.compose.ui.text.TextStyle(
                            color = Color(0xFFE9ECF2),
                            fontSize = 15.sp,
                        ),
                        modifier = Modifier
                            .weight(1f)
                            .padding(end = 6.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color.Transparent,
                            unfocusedBorderColor = Color.Transparent,
                            disabledBorderColor = Color.Transparent,
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            disabledContainerColor = Color.Transparent,
                            cursorColor = Color(0xFFFFD07A),
                        ),
                    )
                }
            }

            // M-8 — white send pill. Picks up the Grok-Ani "Text"
            // button's silhouette: tall rounded rect with a high-
            // contrast white fill and a dark glyph + label, so the
            // primary action is always the brightest thing on the
            // bottom row regardless of background.
            SendPillButton(
                enabled = sendEnabled,
                onClick = onSend,
            )
        }
    }
}

/**
 * M-8 — soft-violet circular button used by the mic / camera
 * affordances on the bottom dock and (re-skinned, smaller) by the
 * top-right menu. Pulled into a helper so the two surfaces stay in
 * lockstep when we tweak the chrome.
 */
@Composable
private fun CircularDockButton(
    icon: ImageVector,
    contentDescription: String,
    tint: Color,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(48.dp)
            .background(MioMenuButtonColor, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        IconButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.size(48.dp),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = tint,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

/**
 * M-8 — the bright "Send" pill on the right of the input row. White
 * fill so it pops against the dark backdrop; dims to a translucent
 * pearl when there's nothing to send. The icon + label echo Grok's
 * "Text" pill, but we use a send arrow + the "Send" verb since the
 * mic button already handles voice/text mode switching elsewhere.
 */
@Composable
private fun SendPillButton(
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val bg = if (enabled) Color.White else Color(0x66FFFFFF)
    val fg = if (enabled) Color(0xFF181225) else Color(0x66181225)
    Surface(
        color = bg,
        shape = RoundedCornerShape(24.dp),
        modifier = Modifier
            .heightIn(min = 48.dp)
            .clickable(enabled = enabled, onClick = onClick),
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Send,
                contentDescription = stringResLocal(R.string.chat_send),
                tint = fg,
                modifier = Modifier.size(18.dp),
            )
            Text(
                text = stringResLocal(R.string.chat_send),
                color = fg,
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * M-4 — the bottom-row content while voice-input mode is active. Shows
 * the live partial transcript as it streams in, or a muted "Listening…"
 * placeholder between utterances.
 */
@Composable
private fun VoiceListeningIndicator(
    partial: String,
    modifier: Modifier = Modifier,
) {
    val listening = stringResLocal(R.string.chat_voice_listening)
    val showingPartial = partial.isNotBlank()
    Text(
        text = if (showingPartial) partial else listening,
        color = if (showingPartial) Color(0xFFE9ECF2) else Color(0xFF9AA3B2),
        fontSize = 15.sp,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/* ────────────────────────────────────────────────────────────────────── */
/*  History overlay: a translucent LazyColumn covering ~70% of the screen */
/*  when tapped. Tap dim background or Close button to dismiss.           */
/* ────────────────────────────────────────────────────────────────────── */

@Composable
private fun HistoryOverlay(
    chatLog: List<MioForegroundService.ChatEntry>,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(chatLog.size) {
        if (chatLog.isNotEmpty()) listState.animateScrollToItem(chatLog.lastIndex)
    }

    Box(
        modifier = modifier
            .background(Color(0xCC0B0C12))
            .clickable(onClick = onDismiss),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.75f)
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 8.dp)
                .background(Color(0xFF12141B), RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp))
                .clickable(enabled = false, onClick = {}),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResLocal(R.string.chat_history_title),
                    color = Color(0xFFE9ECF2),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResLocal(R.string.chat_history_close),
                        tint = Color(0xFF9AA3B2),
                    )
                }
            }
            if (chatLog.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        text = stringResLocal(R.string.chat_history_empty),
                        color = Color(0xFF9AA3B2),
                        modifier = Modifier.padding(32.dp),
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(chatLog, key = { System.identityHashCode(it) }) { entry ->
                        ChatBubble(entry)
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                }
            }
        }
    }
}

@Composable
private fun ChatBubble(entry: MioForegroundService.ChatEntry) {
    val isUser = entry is MioForegroundService.ChatEntry.User
    val isSystem = entry is MioForegroundService.ChatEntry.System
    val bg = when {
        isSystem -> Color(0x33FF8A8A)
        isUser -> Color(0xFF2A3A4A)
        else -> Color(0xFF1B1F29)
    }
    val align = if (isUser) Alignment.CenterEnd else Alignment.CenterStart

    Box(modifier = Modifier.fillMaxWidth(), contentAlignment = align) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .background(bg, RoundedCornerShape(12.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text = entry.text,
                color = if (isSystem) Color(0xFFFF8A8A) else Color(0xFFE9ECF2),
                fontSize = 14.sp,
                fontWeight = if (isUser) FontWeight.Medium else FontWeight.Normal,
            )
            (entry as? MioForegroundService.ChatEntry.Assistant)?.caption?.let {
                Spacer(Modifier.height(4.dp))
                Text(text = it, color = Color(0xFFFFD07A), fontSize = 12.sp)
            }
        }
    }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                */
/* ────────────────────────────────────────────────────────────────────── */

@Composable
private fun stringResLocal(id: Int): String {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    return remember(id) { ctx.getString(id) }
}

// High-end dark-purple backdrop: a deep muted aubergine at the top
// settling into near-black plum at the bottom. Sits behind the
// transparent avatar WebView and the translucent chat pills on
// secondary screens (settings, battery guide, gesture guide) where
// the user is scrolling a list and a calmer vertical gradient reads
// better than a centered vignette.
internal val MioBackgroundGradient = Brush.verticalGradient(
    0.0f to Color(0xFF2A2140),
    0.55f to Color(0xFF181225),
    1.0f to Color(0xFF0B0810),
)

/**
 * Decode the base64 payload of an [AttachedImageArgs] back into raw
 * bytes for the in-dock thumbnail preview — but only for the four
 * image media types. PDFs return null so [AttachmentPreviewRow] falls
 * through to its PDF-chip branch instead of trying to render a
 * Bitmap from PDF bytes (which would fail silently).
 */
private fun decodeImagePreviewBytes(image: AttachedImageArgs): ByteArray? {
    if (image.mediaType == "application/pdf") return null
    return runCatching {
        Base64.decode(image.data, Base64.NO_WRAP)
    }.getOrNull()
}

// M-8 — chat-surface radial vignette. A soft lavender bloom near the
// figure's centre fades into deep aubergine at the edges, mimicking
// the spotlight-on-stage backdrop of Grok-style anime avatars. The
// avatar canvas paints transparently in front; the bloom gives her
// silhouette something to rim against and stops the dark background
// from reading as a flat black wall behind a floating figure.
//
// Reserved for the chat surface only — [MioBackgroundGradient] still
// drives the calmer scrolling pages.
internal val MioChatBackgroundGradient = Brush.radialGradient(
    0.0f to Color(0xFF3D2A5C),
    0.55f to Color(0xFF1A132A),
    1.0f to Color(0xFF080610),
)

// M-8 shared chrome colours. Hoisted as top-level vals so the menu,
// the bottom dock, and any future surface that wants to reuse the
// same "soft-violet glass" look stay perfectly synchronised.
//
// `MioMenuButtonColor`  — the small circular icon buttons (top-right
// menu, mic, camera). Equal-ish saturation to the input pill so the
// dock reads as one cohesive surface even though it's drawn from
// three separate widgets.
//
// `MioInputPillColor`   — the long center input pill. Same hue, a
// touch denser so the textfield boundary is clearly distinct from
// the circular buttons hugging it on either side.
internal val MioMenuButtonColor = Color(0xCC2A1F40)
internal val MioInputPillColor = Color(0xE61F1733)
