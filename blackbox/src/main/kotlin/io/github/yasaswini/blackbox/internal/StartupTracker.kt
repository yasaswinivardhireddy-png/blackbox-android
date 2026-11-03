package io.github.yasaswini.blackbox.internal

internal class StartupRecord(val type: String, val activity: String, val durationMs: Long, val processStartToSdkInitMs: Long)

/**
 * Measures time to first frame. A cold start runs from process start (as requested by the
 * system) to the first frame of the first Activity; a warm start runs from Activity creation.
 * [launchedForActivity] is asked when the first Activity is created.
 */
internal class StartupTracker(
    private val processStartUptimeMs: Long,
    private val launchedForActivity: () -> Boolean,
    private val sdkInitStartUptimeMs: Long,
) {
    private class Pending(val type: String, val activity: String, val startUptimeMs: Long)

    private var pending: Pending? = null
    private var firstActivitySeen = false

    @Synchronized
    fun onActivityCreated(activity: String, hasSavedState: Boolean, appInBackground: Boolean, nowUptimeMs: Long) {
        if (!firstActivitySeen) {
            firstActivitySeen = true
            pending = if (launchedForActivity() && !hasSavedState) {
                Pending("cold", activity, processStartUptimeMs)
            } else {
                Pending("warm", activity, nowUptimeMs)
            }
        } else if (appInBackground) {
            pending = Pending("warm", activity, nowUptimeMs)
        }
    }

    /** Returns the finished startup if [activity]'s first frame completes one. */
    @Synchronized
    fun onFirstFrame(activity: String, frameEndUptimeMs: Long): StartupRecord? {
        val p = pending ?: return null
        if (p.activity != activity) return null
        pending = null
        val duration = frameEndUptimeMs - p.startUptimeMs
        if (duration <= 0 || duration > MAX_STARTUP_MS) return null
        val preInit = if (p.type == "cold") sdkInitStartUptimeMs - processStartUptimeMs else -1
        return StartupRecord(p.type, p.activity, duration, preInit)
    }

    private companion object {
        const val MAX_STARTUP_MS = 60_000L
    }
}
