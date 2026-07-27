package io.mio.mobile.secure

import android.net.Uri

/**
 * Decoded form of the desktop's QR pair payload (see
 * `desktop/src/main/ipcShim.ts > encodePairingUri`).
 *
 * The QR encodes:
 *
 *   mio://pair?h=<host>&p=<port>&t=<token>&d=<deviceId>&v=0
 *
 * This is also the URI shape the Android manifest's deep-link filter
 * matches — so if the desktop ever shares the URI through any other
 * channel (clipboard, NFC, mail), tapping it lands in `MainActivity`
 * with the same parser used for the QR scanner.
 */
data class PairingPayload(
    val host: String,
    val port: Int,
    val token: String,
    val deviceId: String,
    val protocolVersion: Int,
)

object PairingUri {
    private const val SCHEME = "mio"
    private const val HOST = "pair"

    /**
     * Parse a `mio://pair?…` URI into a `PairingPayload`. Returns null
     * for any malformed input (wrong scheme/host, missing fields,
     * non-numeric port, version mismatch). Caller should surface a
     * generic "doesn't look like a Mio pairing URI" error.
     */
    fun parse(raw: String?): PairingPayload? {
        if (raw.isNullOrBlank()) return null
        val uri = runCatching { Uri.parse(raw.trim()) }.getOrNull() ?: return null
        if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
        if (!HOST.equals(uri.host, ignoreCase = true)) return null

        val host = uri.getQueryParameter("h")?.takeIf { it.isNotBlank() } ?: return null
        val portRaw = uri.getQueryParameter("p") ?: return null
        val port = portRaw.toIntOrNull() ?: return null
        if (port <= 0 || port > 65535) return null
        val token = uri.getQueryParameter("t")?.takeIf { it.isNotBlank() } ?: return null
        val deviceId = uri.getQueryParameter("d")?.takeIf { it.isNotBlank() } ?: return null
        val version = uri.getQueryParameter("v")?.toIntOrNull() ?: 0

        return PairingPayload(
            host = host,
            port = port,
            token = token,
            deviceId = deviceId,
            protocolVersion = version,
        )
    }
}
