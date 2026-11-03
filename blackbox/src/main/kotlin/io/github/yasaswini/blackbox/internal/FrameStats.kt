package io.github.yasaswini.blackbox.internal

/**
 * Frame-time statistics for one screen visit. Not thread-safe: it is only touched from the
 * frame-metrics HandlerThread.
 */
internal class FrameStats(val screen: String, val refreshRateHz: Float) {
    var frames = 0
        private set
    var slowFrames = 0
        private set
    var frozenFrames = 0
        private set
    var droppedReports = 0
        private set
    var worstFrameMs = 0.0
        private set
    var totalFrameMs = 0.0
        private set

    /** Frame counts per duration bucket; the last bucket is open-ended. */
    val buckets = IntArray(BUCKET_UPPER_MS.size + 1)

    private val defaultBudgetNs: Long =
        if (refreshRateHz > 1f) (1_000_000_000.0 / refreshRateHz).toLong() else 16_666_667L

    /**
     * @param totalNs time from input handling to the frame reaching the GPU
     * @param deadlineNs the frame's deadline when the platform reports one (API 31+), else 0
     */
    fun add(totalNs: Long, deadlineNs: Long = 0, dropped: Int = 0) {
        val budgetNs = if (deadlineNs > 0) deadlineNs else defaultBudgetNs
        val ms = totalNs / 1_000_000.0
        frames++
        totalFrameMs += ms
        if (totalNs > budgetNs) slowFrames++
        if (totalNs >= FROZEN_NS) frozenFrames++
        if (ms > worstFrameMs) worstFrameMs = ms
        droppedReports += dropped
        var bucket = BUCKET_UPPER_MS.size
        for (i in BUCKET_UPPER_MS.indices) {
            if (ms <= BUCKET_UPPER_MS[i]) {
                bucket = i
                break
            }
        }
        buckets[bucket]++
    }

    fun write(w: JsonWriter, visitMs: Long) {
        w.name("screen").value(screen)
        w.name("refreshRateHz").value(refreshRateHz.toDouble())
        w.name("visitMs").value(visitMs)
        w.name("frames").value(frames)
        w.name("slowFrames").value(slowFrames)
        w.name("frozenFrames").value(frozenFrames)
        w.name("droppedReports").value(droppedReports)
        w.name("worstFrameMs").value(round1(worstFrameMs))
        w.name("meanFrameMs").value(if (frames == 0) 0.0 else round1(totalFrameMs / frames))
        w.name("buckets").beginObject()
        for (i in BUCKET_UPPER_MS.indices) w.name("le${BUCKET_UPPER_MS[i].toInt()}").value(buckets[i])
        w.name("gt${BUCKET_UPPER_MS.last().toInt()}").value(buckets[BUCKET_UPPER_MS.size])
        w.endObject()
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0

    companion object {
        /** Android vitals counts a frame as frozen when it takes 700 ms or more. */
        const val FROZEN_NS = 700_000_000L
        val BUCKET_UPPER_MS = doubleArrayOf(16.0, 33.0, 50.0, 100.0, 250.0, 700.0)
    }
}
