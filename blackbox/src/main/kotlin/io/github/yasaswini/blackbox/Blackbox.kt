package io.github.yasaswini.blackbox

import android.app.Application
import io.github.yasaswini.blackbox.internal.Core

/**
 * Crash, ANR and performance flight recorder for Android apps.
 *
 * Call [init] once from `Application.onCreate`. Every other method is thread-safe, cheap, and a
 * no-op before initialization; none of them throw.
 */
public object Blackbox {
    @Volatile
    private var core: Core? = null

    /** Starts recording. Subsequent calls are ignored. */
    @JvmStatic
    public fun init(application: Application, config: BlackboxConfig) {
        if (core != null) return
        synchronized(this) {
            if (core == null) core = Core.start(application, config)
        }
    }

    @JvmStatic
    public val isInitialized: Boolean get() = core != null

    /** Time [init] spent on the calling thread, in microseconds. */
    @JvmStatic
    public val initDurationMicros: Long get() = core?.initDurationMicros ?: 0

    internal val initPhasesMicros: Map<String, Long> get() = core?.initPhasesMicros ?: emptyMap()

    /** Identifier of the current app session (one per process). */
    @JvmStatic
    public val sessionId: String? get() = core?.sessionId

    /** Adds an entry to the trail of recent events attached to every report. */
    @JvmStatic
    @JvmOverloads
    public fun breadcrumb(message: String, category: String = "app") {
        core?.breadcrumb(category, message)
    }

    /** Attaches a key/value pair to future reports. A null value removes the key. */
    @JvmStatic
    public fun setCustomKey(key: String, value: String?) {
        core?.setCustomKey(key, value)
    }

    /** Records a caught exception without crashing. */
    @JvmStatic
    public fun recordNonFatal(throwable: Throwable) {
        core?.recordNonFatal(throwable)
    }

    /** Reports [instance] as leaked if it is still reachable after the configured delay. */
    @JvmStatic
    public fun watchForLeak(instance: Any, description: String) {
        core?.leakWatcher?.watch(instance, description)
    }

    /** Uploads stored reports now instead of waiting for the app to go to the background. */
    @JvmStatic
    public fun flush() {
        core?.requestUpload()
    }
}
