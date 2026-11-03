# The native crash handler is called through JNI by these exact names.
-keep class io.github.yasaswini.blackbox.internal.NativeBridge {
    native <methods>;
}
