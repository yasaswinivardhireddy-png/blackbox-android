package io.github.yasaswini.blackbox.internal

import android.annotation.TargetApi
import android.app.Activity
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.view.FrameMetrics
import android.view.Window

/**
 * Per-screen frame timing from [FrameMetrics]. Callbacks arrive on a dedicated HandlerThread, so
 * measuring frames adds no work to the UI thread.
 */
@TargetApi(24)
internal class JankMonitor(
    private val handler: Handler,
    private val collectStats: Boolean,
    private val onVisit: (FrameStats, Long) -> Unit,
    private val onFirstFrame: (String, Long) -> Unit,
) {
    private class Visit(val listener: Window.OnFrameMetricsAvailableListener, val stats: FrameStats, val startUptimeMs: Long)

    private val visits = HashMap<Activity, Visit>()

    /** Main thread. */
    fun onResumed(activity: Activity) {
        val window = activity.window ?: return
        val screen = activity.javaClass.name
        val stats = FrameStats(screen, refreshRate(activity))
        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropped ->
            if (metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L) onFirstFrame(screen, frameEndUptimeMs(metrics))
            if (collectStats) {
                val deadline = if (Build.VERSION.SDK_INT >= 31) metrics.getMetric(FrameMetrics.DEADLINE) else 0L
                stats.add(metrics.getMetric(FrameMetrics.TOTAL_DURATION), deadline, dropped)
            }
        }
        window.addOnFrameMetricsAvailableListener(listener, handler)
        visits[activity] = Visit(listener, stats, SystemClock.uptimeMillis())
    }

    /** Main thread. */
    fun onPaused(activity: Activity) {
        val visit = visits.remove(activity) ?: return
        try {
            activity.window?.removeOnFrameMetricsAvailableListener(visit.listener)
        } catch (_: IllegalArgumentException) {
        }
        val visitMs = SystemClock.uptimeMillis() - visit.startUptimeMs
        // Posted to the frame thread, after any callbacks still queued for this visit.
        handler.post { if (visit.stats.frames > 0) onVisit(visit.stats, visitMs) }
    }

    private fun frameEndUptimeMs(metrics: FrameMetrics): Long =
        if (Build.VERSION.SDK_INT >= 26) {
            (metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP) + metrics.getMetric(FrameMetrics.TOTAL_DURATION)) / 1_000_000
        } else {
            SystemClock.uptimeMillis()
        }

    private fun refreshRate(activity: Activity): Float =
        if (Build.VERSION.SDK_INT >= 30) {
            activity.display?.refreshRate ?: 60f
        } else {
            @Suppress("DEPRECATION")
            activity.windowManager.defaultDisplay.refreshRate
        }
}
