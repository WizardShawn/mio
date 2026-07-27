import java.util.Properties
import org.gradle.api.GradleException

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ─── M-2.1 Avatar asset bundling ─────────────────────────────────────────
//
// The Android WebView reuses the desktop's Three.js + three-vrm scene
// verbatim. Source-of-truth lives at `<repo>/desktop/src/renderer/avatar/`
// and `<repo>/desktop/assets/`; we copy a snapshot into the APK's
// `src/main/assets/avatar/` at build time. Drift between desktop and
// mobile is the §7 risk register's "asset copy drifts" line — the
// `checkAvatarSources` task below fails the build if a required source
// path is missing, and warns (without failing) when an optional one is.
//
// Two sub-steps:
//   1. `bundleAvatarJs`   — node + esbuild produces a single
//      `avatar-bundler/dist/main.bundle.js` from `main.ts`.
//   2. `bundleMioAssets`  — copies HTML/CSS + the bundled JS + the
//      shim + the VRM model + the curated animation set into
//      `assets/avatar/`, rewriting `index.html`'s CSP + script tag.
//
// Both hook into `preBuild` so `assembleDebug` / `assembleRelease`
// pick up fresh assets without an extra command. The Gradle clean
// task removes the generated dir.

val repoRoot = rootProject.projectDir.resolve("..").resolve("..").canonicalFile
val desktopAvatarSrc = repoRoot.resolve("desktop/src/renderer/avatar")
val desktopAssetsRoot = repoRoot.resolve("desktop/assets")

// M-7.3 — `lite` flavor source for a trimmed VRM model. The directory
// is opt-in: if `desktop/assets/vrm/mobile/` exists at build time the
// `lite` flavor packages models from there instead of the canonical
// `desktop/assets/vrm/`. When absent (today's default) the `lite`
// flavor packages the same model as `full`, which keeps the build
// green without forcing us to commit a separate asset before perf
// testing tells us we need one.
val desktopMobileVrmDir = desktopAssetsRoot.resolve("vrm/mobile")

val avatarBundlerDir = rootProject.projectDir.resolve("avatar-bundler")
val avatarBundleOutFile = avatarBundlerDir.resolve("dist/main.bundle.js")
val avatarShimFile = avatarBundlerDir.resolve("shim/__mioAvatarBridge.js")
val avatarAssetsOutDir = projectDir.resolve("src/main/assets/avatar")

// Pick the right `npm` command for the OS. Windows ships `npm.cmd`;
// Unix-likes ship `npm`. AGP runs Gradle on the developer's host so
// branch at config time.
val isWindows = System.getProperty("os.name").lowercase().contains("windows")
val npmCmd = if (isWindows) "npm.cmd" else "npm"

// Hard requirements: the scene sources, the bundler, and at least one
// place to look for a model. Without these the APK would ship a broken
// or stale avatar, so the build stops.
val avatarRequiredSources = listOf(
    desktopAvatarSrc.resolve("main.ts"),
    desktopAvatarSrc.resolve("gestures.ts"),
    desktopAvatarSrc.resolve("index.html"),
    desktopAvatarSrc.resolve("style.css"),
    desktopAssetsRoot.resolve("vrm"),
    avatarBundlerDir.resolve("bundle.mjs"),
    avatarBundlerDir.resolve("package.json"),
    avatarShimFile,
)

// Optional: the .vrma animation buckets are NOT redistributed with this
// repository (they belong to pixiv — see desktop/assets/README.md), so a
// fresh clone will not have them. The renderer degrades to the model's
// rest pose when a bucket is empty or absent, and every other feature
// still works, so a missing bucket is a warning and a skipped copy —
// never a build failure.
val avatarAnimationBuckets = listOf("idle", "talking", "extras")
val avatarAnimationDirs: Map<String, File> =
    avatarAnimationBuckets.associateWith { desktopAssetsRoot.resolve("animations/$it") }

val checkAvatarSources by tasks.registering {
    group = "mio"
    description =
        "Fails fast if a source path required by the avatar bundler is missing; warns about absent animations."
    doLast {
        val missing = avatarRequiredSources.filter { !it.exists() }
        if (missing.isNotEmpty()) {
            throw GradleException(
                "Avatar asset sources missing — refusing to build a stale APK:\n" +
                    missing.joinToString("\n") { "  - $it" } +
                    "\n\nFix: see desktop/assets/README.md for what this repository " +
                    "ships and what you must supply. The avatar needs at least one " +
                    "VRM 1.0 model in desktop/assets/vrm/.",
            )
        }

        val missingAnimations = avatarAnimationDirs.filterValues { !it.exists() }
        if (missingAnimations.isNotEmpty()) {
            logger.warn(
                "[mio] No animation source for: ${missingAnimations.keys.joinToString(", ")}. " +
                    "Building anyway — the avatar will render in its rest pose instead of " +
                    "playing idle/talking loops; chat, perception, and gestures are unaffected. " +
                    "These .vrma files are not redistributed with this repository; see " +
                    "desktop/assets/README.md for where to get them, then drop them into " +
                    "desktop/assets/animations/<bucket>/ and rebuild.",
            )
        }
    }
}

val installAvatarBundlerDeps by tasks.registering(Exec::class) {
    group = "mio"
    description = "Runs `npm install` for the avatar-bundler workspace if node_modules is absent."
    dependsOn(checkAvatarSources)
    workingDir = avatarBundlerDir
    // node_modules/ is the install marker; skip the install if already present.
    onlyIf { !avatarBundlerDir.resolve("node_modules").exists() }
    inputs.file(avatarBundlerDir.resolve("package.json"))
    outputs.dir(avatarBundlerDir.resolve("node_modules"))
    commandLine(npmCmd, "install", "--no-audit", "--no-fund", "--loglevel=error")
}

val bundleAvatarJs by tasks.registering(Exec::class) {
    group = "mio"
    description = "esbuild-bundles desktop/src/renderer/avatar/main.ts into avatar-bundler/dist/main.bundle.js."
    dependsOn(installAvatarBundlerDeps)
    workingDir = avatarBundlerDir
    inputs.file(avatarBundlerDir.resolve("bundle.mjs"))
    inputs.dir(desktopAvatarSrc)
    inputs.dir(repoRoot.resolve("desktop/src/shared"))
    outputs.file(avatarBundleOutFile)
    commandLine(npmCmd, "run", "build", "--silent")
}

val bundleMioAssets by tasks.registering {
    group = "mio"
    description = "Copies the avatar HTML/CSS, bundled JS, shim, VRM, and animations into APK assets."
    dependsOn(bundleAvatarJs)
    inputs.file(avatarBundleOutFile)
    inputs.file(avatarShimFile)
    inputs.file(desktopAvatarSrc.resolve("index.html"))
    inputs.file(desktopAvatarSrc.resolve("style.css"))
    inputs.dir(desktopAssetsRoot.resolve("vrm"))
    // Optional — absent on a fresh clone; see checkAvatarSources above.
    inputs.dir(desktopAssetsRoot.resolve("animations")).optional(true)
    outputs.dir(avatarAssetsOutDir)
    doLast {
        // Fresh copy on every run — the inputs/outputs hashing means
        // this whole block is skipped when nothing changed, but when
        // it does run we want a clean slate so deleted source files
        // don't linger as ghosts in the APK.
        delete(avatarAssetsOutDir)
        avatarAssetsOutDir.mkdirs()

        // index.html — rewrite CSP (strip cortana-asset:) and replace
        // the `main.ts` module script with two plain scripts (shim
        // then bundle). The desktop renderer's CSP gives `cortana-asset:`
        // permission for image/connect/media; on Android we serve from
        // `file:///android_asset/...` which is same-origin under the
        // WebView, so we just need `'self' blob: data:` for the
        // VRM-texture blob URLs and inline JSON workers.
        val src = desktopAvatarSrc.resolve("index.html").readText(Charsets.UTF_8)
        val rewritten = src
            .replace(Regex("(\\s*cortana-asset:)"), "")
            .replace(
                "<script type=\"module\" src=\"./main.ts\"></script>",
                "<script src=\"./__mioAvatarBridge.js\"></script>\n    " +
                    "<script src=\"./main.bundle.js\"></script>",
            )
        avatarAssetsOutDir.resolve("index.html").writeText(rewritten, Charsets.UTF_8)

        copy {
            from(desktopAvatarSrc.resolve("style.css"))
            into(avatarAssetsOutDir)
        }
        copy {
            // Only the runtime JS — esbuild's external `.map` file
            // (when MIO_BUNDLER_NO_SOURCEMAP=0) stays in the bundler's
            // `dist/` for in-IDE debugging; the APK ships only what
            // the WebView actually executes.
            from(avatarBundleOutFile)
            into(avatarAssetsOutDir)
        }
        copy {
            from(avatarShimFile)
            into(avatarAssetsOutDir)
        }

        // VRM model + animations. We mirror the desktop's resolution
        // order (any .vrm in <root>/vrm/ counts; first wins on desktop,
        // first wins here too).
        copy {
            from(desktopAssetsRoot.resolve("vrm")) { include("*.vrm") }
            into(avatarAssetsOutDir.resolve("vrm"))
        }
        // Skip buckets the clone doesn't have rather than failing; the
        // warning was already emitted by checkAvatarSources.
        for ((bucket, dir) in avatarAnimationDirs) {
            if (!dir.isDirectory) continue
            copy {
                from(dir) { include("*.vrma") }
                into(avatarAssetsOutDir.resolve("animations/$bucket"))
            }
        }
    }
}

// M-7.3 — `lite` flavor VRM override. When `desktop/assets/vrm/mobile/`
// exists, populate `app/src/lite/assets/avatar/vrm/` with its contents.
// AGP merges per-flavor source sets on top of `main`, so this directory
// shadows the canonical VRM the `bundleMioAssets` task writes — for
// the `lite` flavor only. If the override dir doesn't exist (today's
// default), `lite` falls back to the same model as `full`.
val liteVrmOverrideOutDir = projectDir.resolve("src/lite/assets/avatar/vrm")
val bundleLiteVrmOverride by tasks.registering {
    group = "mio"
    description =
        "When desktop/assets/vrm/mobile/ exists, copies trimmed VRMs into src/lite/assets/avatar/vrm/."
    inputs.dir(desktopMobileVrmDir).optional(true)
    outputs.dir(liteVrmOverrideOutDir)
    doLast {
        delete(liteVrmOverrideOutDir)
        if (desktopMobileVrmDir.exists() && desktopMobileVrmDir.isDirectory) {
            liteVrmOverrideOutDir.mkdirs()
            copy {
                from(desktopMobileVrmDir) { include("*.vrm") }
                into(liteVrmOverrideOutDir)
            }
            println(
                "[mio] lite flavor: trimmed VRM(s) copied from " +
                    "${desktopMobileVrmDir.relativeTo(repoRoot)} → " +
                    "${liteVrmOverrideOutDir.relativeTo(projectDir)}",
            )
        }
    }
}

// Wire into AGP's task graph. `preBuild` is the canonical "before any
// real work happens" hook; tying the bundler here means `:app:assembleDebug`
// always picks up fresh assets, and `./gradlew clean` properly nukes them
// (registered via `outputs.dir` above).
afterEvaluate {
    tasks.named("preBuild").configure {
        dependsOn(bundleMioAssets)
    }
    // Only the `lite*` variants run the override copy; this keeps the
    // `full` builds from accidentally seeing the trimmed VRM via a
    // stale generated source dir.
    tasks.matching { it.name.startsWith("merge") && it.name.contains("LiteAssets", ignoreCase = true) }
        .configureEach { dependsOn(bundleLiteVrmOverride) }
}

// M-7.5 — release signing config. The keystore + password file live
// under `mobile/android/keystore/` and are gitignored. If the file
// doesn't exist (fresh clone, or a developer who hasn't yet copied
// the shared keystore), we silently skip wiring the release config
// and `release` builds fall back to debug signing — keeps a fresh
// clone building without forcing a secret into the repo.
val keystorePropsFile: File = rootProject.projectDir.resolve("keystore/keystore.properties")
val keystoreProps = Properties()
if (keystorePropsFile.exists()) {
    keystorePropsFile.inputStream().use { stream -> keystoreProps.load(stream) }
}

android {
    namespace = "io.mio.mobile"
    compileSdk = 34

    if (keystoreProps.getProperty("storeFile") != null) {
        signingConfigs {
            create("release") {
                storeFile = rootProject.projectDir.resolve(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    defaultConfig {
        applicationId = "io.mio.mobile"
        // Min SDK 26 (Android 8.0) — matches MOBILE_DEVELOPMENT.md Phase M-1.
        // 26 unlocks foreground services with proper notification channels and
        // the Android Keystore APIs we rely on for token storage.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        vectorDrawables { useSupportLibrary = true }
    }

    // M-7.3 — flavor split. `full` ships the canonical VRM, `lite`
    // optionally substitutes a trimmed model from
    // `desktop/assets/vrm/mobile/` when one is present (otherwise it
    // builds identically to `full`). `full` is the default for
    // Studio's "Sync now" + `./gradlew assembleDebug` shorthand.
    flavorDimensions += "size"
    productFlavors {
        create("full") {
            dimension = "size"
            isDefault = true
        }
        create("lite") {
            dimension = "size"
            versionNameSuffix = "-lite"
        }
    }

    buildTypes {
        release {
            // M-7.5 — `signingConfigs.release` is wired below from a
            // gitignored `keystore/keystore.properties` file. When the
            // file isn't present (fresh clone), the release build
            // silently falls back to the debug signing key so the
            // build still succeeds.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
        debug {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            // ML Kit + OkHttp + Kotlinx all ship duplicate META-INF entries that
            // the bundler refuses without an explicit pickFirst.
            excludes += "META-INF/{AL2.0,LGPL2.1,DEPENDENCIES}"
            excludes += "META-INF/INDEX.LIST"
            excludes += "META-INF/io.netty.versions.properties"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.androidx.compose.foundation)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    implementation(libs.mlkit.barcode.scanning)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    implementation(libs.androidx.webkit)
}
