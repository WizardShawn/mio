// Phase M-1 — minimal Android scaffold for Mio Mobile.
//
// Repository order: google() first so AGP/Compose plugins resolve from
// Google's mirror. Maven Central second for OkHttp/coroutines/ML Kit.
// We intentionally pin everything via the version catalog
// (gradle/libs.versions.toml) so a `./gradlew --refresh-dependencies`
// can't silently float versions.

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "mio-mobile"
include(":app")
