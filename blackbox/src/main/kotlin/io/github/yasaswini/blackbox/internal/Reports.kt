package io.github.yasaswini.blackbox.internal

import android.os.Debug

internal class Report(val id: String, val type: String, val createdAtMs: Long, val json: String)

internal object ReportTypes {
    const val SESSION = "session"
    const val JVM_CRASH = "jvm_crash"
    const val NATIVE_CRASH = "native_crash"
    const val NON_FATAL = "non_fatal"
    const val APP_HANG = "app_hang"
    const val APP_EXIT = "app_exit"
    const val JANK = "jank"
    const val LEAK = "leak"
    const val STARTUP = "startup"

    /** Lowest value is dropped first when the on-disk queue is full. */
    fun priority(type: String): Int = when (type) {
        JVM_CRASH, NATIVE_CRASH, APP_EXIT -> 3
        APP_HANG, NON_FATAL, LEAK -> 2
        SESSION -> 1
        else -> 0
    }
}

/** Builds the common report envelope; each report type supplies only its payload. */
internal class ReportFactory(
    private val env: Environment,
    private val breadcrumbs: Breadcrumbs,
    private val customKeys: () -> Map<String, String>,
    private val isForeground: () -> Boolean,
    private val sessionStartMs: Long,
) {
    fun create(
        type: String,
        sessionId: String,
        id: String = Ids.newId(),
        createdAtMs: Long = System.currentTimeMillis(),
        includeContext: Boolean = true,
        payload: (JsonWriter) -> Unit,
    ): Report {
        val w = JsonWriter(if (includeContext) 8192 else 2048)
        w.beginObject()
        w.name("schema").value(1)
        w.name("id").value(id)
        w.name("type").value(type)
        w.name("sessionId").value(sessionId)
        w.name("timestamp").value(createdAtMs)
        w.name("sdk").value(SDK_VERSION)
        w.name("app"); env.writeApp(w)
        w.name("device"); env.writeDevice(w)
        if (includeContext) {
            w.name("state").beginObject()
            w.name("foreground").value(isForeground())
            w.name("sessionAgeMs").value(createdAtMs - sessionStartMs)
            w.endObject()
            writeMemory(w)
            w.name("breadcrumbs").beginArray()
            for (b in breadcrumbs.snapshot()) {
                w.beginObject().name("t").value(b.timeMs).name("c").value(b.category).name("m").value(b.message).endObject()
            }
            w.endArray()
            val keys = customKeys()
            if (keys.isNotEmpty()) {
                w.name("keys").beginObject()
                for ((k, v) in keys) w.name(k).value(v)
                w.endObject()
            }
        }
        w.name("payload").beginObject()
        payload(w)
        w.endObject()
        w.endObject()
        return Report(id, type, createdAtMs, w.toString())
    }

    private fun writeMemory(w: JsonWriter) {
        val runtime = Runtime.getRuntime()
        w.name("memory").beginObject()
        w.name("heapUsedKb").value((runtime.totalMemory() - runtime.freeMemory()) / 1024)
        w.name("heapMaxKb").value(runtime.maxMemory() / 1024)
        w.name("nativeHeapKb").value(Debug.getNativeHeapAllocatedSize() / 1024)
        w.endObject()
    }

    companion object {
        const val SDK_VERSION = "blackbox-android/1.0.0"
    }
}

/** Serializes stack traces compactly: c = class, m = method, f = file, l = line. */
internal object Stacks {
    const val MAX_FRAMES = 64
    private const val MAX_THREADS = 40
    private const val MAX_THREAD_FRAMES = 32
    private const val MAX_CAUSES = 4

    fun writeFrames(w: JsonWriter, frames: Array<StackTraceElement>, max: Int = MAX_FRAMES) {
        w.beginArray()
        val count = minOf(frames.size, max)
        for (i in 0 until count) {
            val f = frames[i]
            w.beginObject()
            w.name("c").value(f.className)
            w.name("m").value(f.methodName)
            f.fileName?.let { w.name("f").value(it) }
            w.name("l").value(f.lineNumber)
            w.endObject()
        }
        w.endArray()
    }

    fun writeThrowable(w: JsonWriter, throwable: Throwable, depth: Int = 0) {
        w.beginObject()
        w.name("type").value(throwable.javaClass.name)
        w.name("message").value(throwable.message?.take(1024))
        w.name("frames")
        writeFrames(w, throwable.stackTrace)
        if (throwable.stackTrace.size > MAX_FRAMES) w.name("omittedFrames").value(throwable.stackTrace.size - MAX_FRAMES)
        val cause = throwable.cause
        if (cause != null && cause !== throwable && depth < MAX_CAUSES) {
            w.name("cause")
            writeThrowable(w, cause, depth + 1)
        }
        w.endObject()
    }

    /** All threads except [skip], main thread first. */
    fun writeThreads(w: JsonWriter, threads: Map<Thread, Array<StackTraceElement>>, skip: Thread?, mainThread: Thread?) {
        val ordered = threads.entries
            .filter { it.key !== skip }
            .sortedWith(compareBy({ it.key !== mainThread }, { it.key.name }))
            .take(MAX_THREADS)
        w.beginArray()
        for ((thread, frames) in ordered) {
            w.beginObject()
            w.name("name").value(thread.name)
            w.name("state").value(thread.state.name)
            w.name("main").value(thread === mainThread)
            w.name("daemon").value(thread.isDaemon)
            w.name("frames")
            writeFrames(w, frames, MAX_THREAD_FRAMES)
            w.endObject()
        }
        w.endArray()
    }

    fun causalChain(throwable: Throwable): Sequence<Throwable> =
        generateSequence(throwable) { t -> t.cause?.takeIf { it !== t } }.take(MAX_CAUSES + 1)
}
