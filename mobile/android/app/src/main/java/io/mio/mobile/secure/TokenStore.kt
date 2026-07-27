package io.mio.mobile.secure

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Phase M-1 secret store. Mirrors the desktop's `auth.ts` pattern:
 * keep an opaque encrypted blob on disk, hand back the plaintext
 * token only on demand. Key lives in the Android Keystore (hardware-
 * backed where available) so even a `pm uninstall && restore` from
 * an OEM cloud-backup channel can't lift the token bytes out.
 *
 * Storage shape (single-device v1, easy to extend):
 *
 *   shared_prefs / mio_secrets.xml:
 *     pair.host       = String
 *     pair.port       = Int
 *     pair.deviceId   = String
 *     pair.token.iv   = base64(IV)
 *     pair.token.ct   = base64(ciphertext)
 *     pair.protocolVersion = Int
 *
 * If the AES key is rotated (factory reset, "Forget desktop") the
 * ciphertext becomes undecryptable and we fall back to "unpaired" —
 * which is the right outcome.
 */
class TokenStore private constructor(private val context: Context) {

    fun savePairing(payload: PairingPayload) {
        val key = ensureKey()
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, key)
        }
        val ciphertext = cipher.doFinal(payload.token.toByteArray(Charsets.UTF_8))
        prefs().edit {
            putString(KEY_HOST, payload.host)
            putInt(KEY_PORT, payload.port)
            putString(KEY_DEVICE_ID, payload.deviceId)
            putInt(KEY_PROTOCOL_VERSION, payload.protocolVersion)
            putString(KEY_TOKEN_IV, Base64.encodeToString(cipher.iv, BASE64_FLAGS))
            putString(KEY_TOKEN_CT, Base64.encodeToString(ciphertext, BASE64_FLAGS))
        }
    }

    fun loadPairing(): PairingPayload? {
        val p = prefs()
        val host = p.getString(KEY_HOST, null) ?: return null
        val port = p.getInt(KEY_PORT, -1).takeIf { it > 0 } ?: return null
        val deviceId = p.getString(KEY_DEVICE_ID, null) ?: return null
        val ivB64 = p.getString(KEY_TOKEN_IV, null) ?: return null
        val ctB64 = p.getString(KEY_TOKEN_CT, null) ?: return null
        val version = p.getInt(KEY_PROTOCOL_VERSION, 0)

        val key = runCatching { loadKey() }.getOrNull() ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(
                    Cipher.DECRYPT_MODE,
                    key,
                    GCMParameterSpec(GCM_TAG_BITS, Base64.decode(ivB64, BASE64_FLAGS)),
                )
            }
            val plaintext = cipher.doFinal(Base64.decode(ctB64, BASE64_FLAGS))
            PairingPayload(
                host = host,
                port = port,
                token = String(plaintext, Charsets.UTF_8),
                deviceId = deviceId,
                protocolVersion = version,
            )
        }.getOrNull()
    }

    fun clear() {
        prefs().edit { clear() }
        runCatching {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
        }
    }

    fun isPaired(): Boolean = loadPairing() != null

    // ─── internals ─────────────────────────────────────────────────────

    private fun prefs() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun ensureKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        ks.getEntry(KEY_ALIAS, null)?.let { entry ->
            return (entry as KeyStore.SecretKeyEntry).secretKey
        }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    private fun loadKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val entry = ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
            ?: throw IllegalStateException("Mio token key missing")
        return entry.secretKey
    }

    companion object {
        private const val PREFS_NAME = "mio_secrets"
        private const val KEY_ALIAS = "mio_token_v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val BASE64_FLAGS = Base64.NO_WRAP
        private const val KEY_HOST = "pair.host"
        private const val KEY_PORT = "pair.port"
        private const val KEY_DEVICE_ID = "pair.deviceId"
        private const val KEY_PROTOCOL_VERSION = "pair.protocolVersion"
        private const val KEY_TOKEN_IV = "pair.token.iv"
        private const val KEY_TOKEN_CT = "pair.token.ct"

        @Volatile private var instance: TokenStore? = null

        fun get(context: Context): TokenStore =
            instance ?: synchronized(this) {
                instance ?: TokenStore(context.applicationContext).also { instance = it }
            }
    }
}
