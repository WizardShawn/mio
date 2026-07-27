package io.mio.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import io.mio.mobile.secure.PairingPayload
import io.mio.mobile.secure.PairingUri
import java.util.concurrent.Executors

/**
 * Pairing screen. Phase M-1 supports two ways in:
 *
 * 1. **QR scan** — CameraX preview + ML Kit barcode scanning. The
 *    moment the QR resolves to a `mio://pair?…` URI we hand the
 *    parsed payload up. No tap-to-confirm: the QR is the consent.
 * 2. **Manual paste** — for cases where the camera fails (broken
 *    lens, no permission). The user copies the URI from the desktop
 *    Settings page and pastes it.
 *
 * The desktop's `IpcChannels.PairingIssueQr` mints a fresh token on
 * every QR generation, so accidentally pairing twice with stale data
 * is harmless — only the latest token is honoured.
 */
@Composable
fun PairingScreen(
    initialPayload: PairingPayload? = null,
    onPaired: (PairingPayload) -> Unit,
) {
    val context = LocalContext.current
    var manualMode by remember { mutableStateOf(false) }
    var manualUri by remember { mutableStateOf("") }
    var feedback by remember { mutableStateOf<String?>(null) }

    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA,
            ) == PackageManager.PERMISSION_GRANTED,
        )
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCameraPermission = granted
        if (!granted) feedback = context.getString(io.mio.mobile.R.string.pairing_camera_denied)
    }

    LaunchedEffect(initialPayload) {
        if (initialPayload != null) onPaired(initialPayload)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF12141B))
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringRes(io.mio.mobile.R.string.pairing_headline),
            color = Color(0xFFE9ECF2),
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = stringRes(io.mio.mobile.R.string.pairing_subline),
            color = Color(0xFF9AA3B2),
            fontSize = 14.sp,
        )

        if (manualMode) {
            ManualPasteCard(
                value = manualUri,
                onValueChange = { manualUri = it },
                onSubmit = {
                    val parsed = PairingUri.parse(manualUri)
                    if (parsed == null) {
                        feedback = context.getString(io.mio.mobile.R.string.pairing_invalid_uri)
                    } else {
                        onPaired(parsed)
                    }
                },
                onCancel = { manualMode = false },
            )
        } else if (hasCameraPermission) {
            QrScannerSurface(
                onScanned = { parsed ->
                    onPaired(parsed)
                },
                onError = { reason -> feedback = reason },
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .background(Color(0xFF1B1F29), RoundedCornerShape(16.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringRes(io.mio.mobile.R.string.pairing_camera_denied),
                    color = Color(0xFF9AA3B2),
                    modifier = Modifier.padding(24.dp),
                )
            }
        }

        feedback?.let {
            Text(text = it, color = Color(0xFFFF8A8A), fontSize = 13.sp)
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (!manualMode) {
                Button(
                    onClick = {
                        if (!hasCameraPermission) {
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        }
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringRes(io.mio.mobile.R.string.pairing_scan_button))
                }
                OutlinedButton(
                    onClick = {
                        manualMode = true
                        feedback = null
                    },
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringRes(io.mio.mobile.R.string.pairing_manual_button))
                }
            }
        }

        Spacer(Modifier.fillMaxWidth())
    }
}

@Composable
private fun ManualPasteCard(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = stringRes(io.mio.mobile.R.string.pairing_manual_hint),
            color = Color(0xFF9AA3B2),
            fontSize = 13.sp,
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 80.dp),
            placeholder = { Text("mio://pair?h=…") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            singleLine = false,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onSubmit, modifier = Modifier.weight(1f)) {
                Text(stringRes(io.mio.mobile.R.string.pairing_done))
            }
            OutlinedButton(onClick = onCancel, modifier = Modifier.weight(1f)) {
                Text(stringRes(io.mio.mobile.R.string.pairing_cancel))
            }
        }
    }
}

@Composable
private fun QrScannerSurface(
    onScanned: (PairingPayload) -> Unit,
    onError: (String) -> Unit,
) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val context = LocalContext.current
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val scanner: BarcodeScanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    val resolved = remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .background(Color.Black, RoundedCornerShape(16.dp)),
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setTargetResolution(Size(960, 720))
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(analysisExecutor) { proxy ->
                        if (resolved.value) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        val mediaImage = proxy.image
                        if (mediaImage == null) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        val image = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
                        scanner.process(image)
                            .addOnSuccessListener { barcodes ->
                                for (b in barcodes) {
                                    val raw = b.rawValue ?: continue
                                    val parsed = PairingUri.parse(raw)
                                    if (parsed != null && !resolved.value) {
                                        resolved.value = true
                                        onScanned(parsed)
                                        break
                                    }
                                }
                            }
                            .addOnFailureListener { err ->
                                onError(err.message ?: "scan failed")
                            }
                            .addOnCompleteListener { proxy.close() }
                    }
                    runCatching {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }.onFailure { onError(it.message ?: "camera bind failed") }
                }, ContextCompat.getMainExecutor(ctx))
                previewView
            },
        )
    }
}

@Composable
private fun stringRes(id: Int): String {
    val ctx = LocalContext.current
    return remember(id) { ctx.getString(id) }
}
