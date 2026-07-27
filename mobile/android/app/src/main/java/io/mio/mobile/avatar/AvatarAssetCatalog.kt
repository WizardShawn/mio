package io.mio.mobile.avatar

import android.content.Context
import android.util.Log

/**
 * Enumerates the avatar assets packaged into the APK by the
 * `bundleMioAssets` Gradle task (M-2.1). The desktop equivalent lives
 * at `desktop/src/server/brain/assets.ts`; we re-derive the manifest
 * locally on Android because the WebView can't reach the desktop's
 * file system, and round-tripping the manifest over WS would just
 * mean asking the desktop where to find files that are already on
 * the phone.
 *
 * Resulting URLs point at the WebViewAssetLoader virtual origin
 * (`https://appassets.androidplatform.net/assets/avatar/...`) with each
 * path segment URL-encoded to survive Japanese filenames like `澪.vrm`
 * and `VRMA_02挨拶.vrma`. The loader decodes them and streams the
 * matching file out of the APK's assets.
 *
 * Safe to call from any thread (AssetManager.list is documented as
 * thread-safe). Returns an empty manifest with `vrmPath = null` when
 * the bundle is absent — same shape the desktop's `AssetManifest`
 * uses when no model is dropped in.
 */
class AvatarAssetCatalog(private val context: Context) {

    data class AssetManifest(
        val vrmPath: String?,
        val idleAnimations: List<String>,
        val talkingAnimations: List<String>,
        val extrasAnimations: List<String>,
        /**
         * Wardrobe mirror of `desktop/src/shared/protocol.ts >
         * OutfitDescriptor`. Always non-null; empty when the APK
         * shipped without any `.vrm` files under `assets/avatar/vrm/`.
         */
        val outfits: List<OutfitDescriptor>,
        /**
         * Id of the outfit reflected by [vrmPath]. Null only when the
         * wardrobe is empty.
         */
        val activeOutfitId: String?,
    )

    /**
     * Mirror of `desktop/src/shared/protocol.ts > OutfitDescriptor`.
     * `vrmPath` is the WebView-ready https URL the renderer can
     * `fetch()` directly — i.e. already mapped onto the
     * `appassets.androidplatform.net` virtual origin.
     */
    data class OutfitDescriptor(
        val id: String,
        val label: String,
        val vrmPath: String,
    )

    fun build(): AssetManifest {
        val assets = context.assets
        val vrmNames = listFiles(assets, "$AVATAR_ROOT/vrm")
            .filter { it.endsWith(".vrm", ignoreCase = true) }
        val outfits = buildOutfits(vrmNames)
        val active = outfits.firstOrNull()

        val idle = listFiles(assets, "$AVATAR_ROOT/animations/idle")
            .filter { it.endsWith(".vrma", ignoreCase = true) }
            .map { fileUrl("$AVATAR_ROOT/animations/idle/$it") }
        val talking = listFiles(assets, "$AVATAR_ROOT/animations/talking")
            .filter { it.endsWith(".vrma", ignoreCase = true) }
            .map { fileUrl("$AVATAR_ROOT/animations/talking/$it") }
        val extras = listFiles(assets, "$AVATAR_ROOT/animations/extras")
            .filter { it.endsWith(".vrma", ignoreCase = true) }
            .map { fileUrl("$AVATAR_ROOT/animations/extras/$it") }

        return AssetManifest(
            vrmPath = active?.vrmPath,
            idleAnimations = idle,
            talkingAnimations = talking,
            extrasAnimations = extras,
            outfits = outfits,
            activeOutfitId = active?.id,
        )
    }

    /**
     * Re-render [manifest] so the outfit identified by [outfitId] is
     * the active one (i.e. its `vrmPath` lands in `vrmPath` and its id
     * in `activeOutfitId`). Falls back to the original manifest when
     * the id doesn't match anything in the wardrobe; the desktop's
     * `manifestWithActiveOutfit` follows the same shape.
     */
    fun withActiveOutfit(manifest: AssetManifest, outfitId: String?): AssetManifest {
        if (outfitId.isNullOrBlank()) return manifest
        val match = manifest.outfits.firstOrNull { it.id == outfitId } ?: return manifest
        if (match.id == manifest.activeOutfitId) return manifest
        return manifest.copy(
            vrmPath = match.vrmPath,
            activeOutfitId = match.id,
        )
    }

    /**
     * Resolve [outfitId] to the local APK https URL for the matching
     * VRM file, or null when the phone doesn't have a copy. Used by
     * the foreground service to substitute the desktop's
     * `http://<host>/asset/...` URL with a same-origin local one so
     * three.js' `fetch()` isn't mixed-content blocked.
     */
    fun resolveOutfitUrl(outfitId: String): String? =
        build().outfits.firstOrNull { it.id == outfitId }?.vrmPath

    private fun buildOutfits(vrmNames: List<String>): List<OutfitDescriptor> {
        if (vrmNames.isEmpty()) return emptyList()
        val seen = mutableSetOf<String>()
        val result = mutableListOf<OutfitDescriptor>()
        // Stable, locale-independent ordering so the active-by-default
        // outfit (the first one) matches what the desktop picks for
        // the same set of files.
        for (name in vrmNames.sorted()) {
            var id = outfitIdFromFilename(name)
            if (!seen.add(id)) {
                // Collisions are vanishingly rare (different files
                // collapsing to the same ascii slug) but possible.
                // Append a numeric suffix the way `assets.ts` does so
                // the desktop and mobile derive matching ids in the
                // pathological case.
                var n = 2
                while (!seen.add("${id}_$n")) n += 1
                id = "${id}_$n"
            }
            result += OutfitDescriptor(
                id = id,
                label = outfitLabelFromId(id),
                vrmPath = fileUrl("$AVATAR_ROOT/vrm/$name"),
            )
        }
        return result
    }

    /**
     * Twin of `outfitIdFromFilename` in `desktop/src/server/brain/assets.ts`.
     * Strip extension → strip leading `Mio_`/`Mio-` author prefix →
     * collapse non-alphanumeric runs to `_` → inject `_` between
     * camelCase boundaries → trim outer `_` → lowercase. Filenames
     * that collapse to an empty slug (e.g. the original `澪.vrm`)
     * fall back to `FALLBACK_OUTFIT_ID`.
     *
     * MUST match the desktop's logic byte-for-byte: the `change_clothes`
     * tool sends an `outfitId` derived on the desktop and the mobile
     * catalog has to recognise the exact same id to map it back to
     * the bundled APK copy.
     */
    private fun outfitIdFromFilename(fileName: String): String {
        val base = fileName.substringBeforeLast('.', fileName)
        val stripped = base.replace(Regex("^Mio[_\\-]", RegexOption.IGNORE_CASE), "")
        val slug = stripped
            .replace(Regex("[^A-Za-z0-9]+"), "_")
            .replace(Regex("([a-z0-9])([A-Z])"), "$1_$2")
            .replace(Regex("^_+|_+$"), "")
            .lowercase()
        return if (slug.isEmpty()) FALLBACK_OUTFIT_ID else slug
    }

    /**
     * Twin of `outfitLabelFromId` in `desktop/src/server/brain/assets.ts`.
     * Splits on `_`, title-cases each token; the `default` fallback
     * id always renders as `"Default"`.
     */
    private fun outfitLabelFromId(id: String): String {
        if (id == FALLBACK_OUTFIT_ID) return "Default"
        return id.split('_').filter { it.isNotEmpty() }.joinToString(" ") { token ->
            token.replaceFirstChar { ch -> ch.uppercaseChar() }
        }
    }

    private fun listFiles(assets: android.content.res.AssetManager, dir: String): List<String> {
        return try {
            assets.list(dir)?.toList().orEmpty()
        } catch (err: Throwable) {
            Log.w(TAG, "asset list failed for $dir: ${err.message}")
            emptyList()
        }
    }

    /**
     * Encode each path segment so the WebView can resolve filenames
     * with non-ASCII characters. We deliberately do NOT call
     * `Uri.encode(path)` on the whole string — it would escape the
     * `/` separators and break asset resolution.
     */
    private fun fileUrl(assetPath: String): String {
        val parts = assetPath.split('/')
        val encoded = parts.joinToString("/") { android.net.Uri.encode(it) }
        return "$FILE_PREFIX$encoded"
    }

    companion object {
        private const val TAG = "AvatarAssetCatalog"
        const val AVATAR_ROOT = "avatar"
        /**
         * Mirror of `FALLBACK_OUTFIT_ID` in
         * `desktop/src/server/brain/assets.ts`. Used when an outfit
         * filename is all non-ASCII (e.g. the original `澪.vrm`) and
         * collapses to an empty slug.
         */
        const val FALLBACK_OUTFIT_ID = "default"
        /**
         * APK assets are served to the WebView through WebViewAssetLoader
         * at this virtual https origin (see AvatarWebView). It must be
         * https — not file:// — because three.js loads the VRM with
         * fetch(), and fetch() cannot read file:// URLs.
         */
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val FILE_PREFIX = "https://$ASSET_HOST/assets/"
        /** Page entry point for the WebView to load. */
        const val INDEX_URL = "${FILE_PREFIX}avatar/index.html"
    }
}
