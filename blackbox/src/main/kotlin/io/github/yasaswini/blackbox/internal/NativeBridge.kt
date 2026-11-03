package io.github.yasaswini.blackbox.internal

/** JNI entry points of libblackbox.so, the async-signal-safe native crash handler. */
internal object NativeBridge {
    @Volatile
    var loaded: Boolean = false
        private set

    fun load(): Boolean {
        if (!loaded) {
            loaded = try {
                System.loadLibrary("blackbox")
                true
            } catch (_: Throwable) {
                false
            }
        }
        return loaded
    }

    /** Installs handlers for SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGTRAP and SIGSYS. */
    @JvmStatic
    external fun install(reportPath: String, sessionId: String): Boolean

    /** Mirrors a breadcrumb into a fixed native ring buffer so native crash reports include it. */
    @JvmStatic
    external fun pushBreadcrumb(entry: String)

    /** Writes a report for the current stack without crashing, using the signal-handler code path. */
    @JvmStatic
    external fun writeSelfTest(reportPath: String): Boolean
}
