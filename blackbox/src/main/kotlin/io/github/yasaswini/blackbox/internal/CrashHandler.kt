package io.github.yasaswini.blackbox.internal

import android.os.Looper
import android.os.Process
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.system.exitProcess

/**
 * Records uncaught JVM exceptions synchronously (the process is about to die), then hands the
 * exception to the previously installed handler so the platform's crash flow is unchanged.
 */
internal class CrashHandler(
    private val sessionId: String,
    reportsProvider: Lazy<ReportFactory>,
    storeProvider: Lazy<ReportStore>,
    private val previous: Thread.UncaughtExceptionHandler? = Thread.getDefaultUncaughtExceptionHandler(),
) : Thread.UncaughtExceptionHandler {
    // Usually created by the SDK's background thread long before a crash; a crash during startup
    // creates them here.
    private val reports by reportsProvider
    private val store by storeProvider
    private val handling = AtomicBoolean(false)

    fun install() {
        Thread.setDefaultUncaughtExceptionHandler(this)
    }

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
        try {
            // Only the first crashing thread is recorded; others go straight to the platform.
            if (handling.compareAndSet(false, true)) record(thread, throwable)
        } catch (_: Throwable) {
            // Never let a failure here hide the app's own crash.
        } finally {
            val next = previous
            if (next != null) {
                next.uncaughtException(thread, throwable)
            } else {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }
    }

    private fun record(thread: Thread, throwable: Throwable) {
        val oom = Stacks.causalChain(throwable).any { it is OutOfMemoryError }
        val mainThread = Looper.getMainLooper()?.thread
        val report = try {
            reports.create(ReportTypes.JVM_CRASH, sessionId) { w ->
                writeThread(w, thread, mainThread)
                w.name("oom").value(oom)
                w.name("exception")
                Stacks.writeThrowable(w, throwable)
                // Capturing every thread is skipped on OOM: it allocates, and the heap is exhausted.
                if (!oom) {
                    w.name("threads")
                    Stacks.writeThreads(w, Thread.getAllStackTraces(), skip = thread, mainThread = mainThread)
                }
            }
        } catch (_: Throwable) {
            reports.create(ReportTypes.JVM_CRASH, sessionId, includeContext = false) { w ->
                writeThread(w, thread, mainThread)
                w.name("oom").value(oom)
                w.name("exception").beginObject().name("type").value(throwable.javaClass.name)
                    .name("frames").beginArray().endArray().endObject()
                w.name("degraded").value(true)
            }
        }
        store.write(report)
    }

    private fun writeThread(w: JsonWriter, thread: Thread, mainThread: Thread?) {
        w.name("thread").beginObject()
            .name("name").value(thread.name)
            .name("main").value(thread === mainThread)
            .endObject()
    }
}
