# R8 / ProGuard rules. Phase M-1 ships unminified, so this file is a
# placeholder for the eventual release build.

# Keep generated kotlinx.serialization companion serializer accessors —
# they're reflected on at runtime when a frame's class is decoded.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keep,includedescriptorclasses class io.mio.mobile.net.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
