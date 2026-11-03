package io.github.yasaswini.blackbox.internal

import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/**
 * Detects main-thread hangs in-process. A background thread posts a no-op to the main Looper and
 * checks that it ran; if it has not run within [thresholdMs], the main thread is sampled until it
 * recovers. The report is rewritten as the hang grows, so it survives if the system kills the
 * process for an ANR. The watchdog sleeps while the app is in the background to save battery.
 */
internal class AnrWatchdog(
    private val thresholdMs: Long,
    private val intervalMs: Long,
    private val onHang: (HangEvent) -> Unit,
) : Thread("blackbox-anr-watchdog") {

    class HangEvent(
        val id: String,
        val startedAtMs: Long,
        val blockedMs: Long,
        val ongoing: Boolean,
        val mainThreadState: String?,
        val samples: List<Array<StackTraceElement>>,
        val threads: Map<Thread, Array<StackTraceElement>>?,
    )

    private class Episode(val id: String, val startedAtMs: Long) {
        val samples = ArrayList<Array<StackTraceElement>>()
        var threads: Map<Thread, Array<StackTraceElement>>? = null
        var mainState: String? = null

        fun event(blockedMs: Long, ongoing: Boolean) = HangEvent(id, startedAtMs, blockedMs, ongoing, mainState, ArrayList(samples), threads)
    }

    private val mainLooper = Looper.getMainLooper()
    private val mainHandler = Handler(mainLooper)
    private val lock = Object()

    @Volatile private var foreground = false
    @Volatile private var inFlightSeq = 0L
    @Volatile private var acknowledgedSeq = 0L
    @Volatile private var ackUptimeMs = 0L

    // Reused for every ping, so the watchdog allocates nothing while the app is healthy.
    private val ack = Runnable {
        ackUptimeMs = SystemClock.uptimeMillis()
        acknowledgedSeq = inFlightSeq
    }

    init {
        isDaemon = true
        priority = MIN_PRIORITY
    }

    fun setForeground(value: Boolean) {
        synchronized(lock) {
            foreground = value
            lock.notifyAll()
        }
    }

    override fun run() {
        var seq = 0L
        var postedAt = 0L
        var episode: Episode? = null
        try {
            while (!isInterrupted) {
                if (!foreground) {
                    episode = null
                    synchronized(lock) {
                        while (!foreground) lock.wait()
                    }
                    seq = 0
                }
                val now = SystemClock.uptimeMillis()
                if (seq == 0L || acknowledgedSeq == seq) {
                    episode?.let { onHang(it.event(ackUptimeMs - postedAt, ongoing = false)) }
                    episode = null
                    seq++
                    inFlightSeq = seq
                    postedAt = now
                    mainHandler.post(ack)
                } else {
                    val blocked = now - postedAt
                    if (blocked >= thresholdMs && !Debug.isDebuggerConnected()) {
                        val current = episode
                        if (current == null) {
                            val started = Episode(Ids.newId(), System.currentTimeMillis() - blocked)
                            started.mainState = mainLooper.thread.state.name
                            started.samples.add(mainLooper.thread.stackTrace)
                            started.threads = Thread.getAllStackTraces()
                            episode = started
                            onHang(started.event(blocked, ongoing = true))
                        } else if (current.samples.size < MAX_SAMPLES) {
                            current.samples.add(mainLooper.thread.stackTrace)
                            if (current.samples.size % REWRITE_EVERY == 0) onHang(current.event(blocked, ongoing = true))
                        }
                    }
                }
                sleep(intervalMs)
            }
        } catch (_: InterruptedException) {
            // Shutting down.
        }
    }

    private companion object {
        const val MAX_SAMPLES = 12
        const val REWRITE_EVERY = 4
    }
}
