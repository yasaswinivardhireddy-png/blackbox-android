package io.github.yasaswini.blackbox.internal

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import io.github.yasaswini.blackbox.BlackboxConfig
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadLocalRandom

/** Wires the recorders together. Created once by Blackbox.init on the app's main thread. */
internal class Core private constructor(
    private val app: Application,
    private val config: BlackboxConfig,
    private val initStartUptimeMs: Long,
) {
    // Main-thread cost of each init step in microseconds, also emitted as Perfetto trace sections.
    private val phases = LinkedHashMap<String, Long>()

    private inline fun <T> phase(name: String, block: () -> T): T {
        Trace.beginSection("Blackbox.$name")
        val start = System.nanoTime()
        try {
            return block()
        } finally {
            phases[name] = (System.nanoTime() - start) / 1_000
            Trace.endSection()
        }
    }

    val sessionId: String = Ids.newId()
    private val sessionStartMs = System.currentTimeMillis()
    private val breadcrumbs = Breadcrumbs()
    private val customKeys = ConcurrentHashMap<String, String>()
    private val mainThread: Thread = Looper.getMainLooper().thread

    // Anything that touches the disk or calls a system service is created on first use, which is
    // normally on the background thread. Under load, a PackageManager call took 31 ms and waiting
    // for a new thread's Looper took up to 58 ms on the main thread of an emulator.
    private val root by lazy { File(app.filesDir, "blackbox") }
    private val nativeDir by lazy { File(root, "native") }
    private val stateFile by lazy { File(root, "state.txt") }
    private val env by lazy { Environment.capture(app) }

    @Volatile private var foreground = false
    private var startedActivities = 0 // Main thread only.

    private val storeLazy = lazy { ReportStore(File(root, "reports"), config.maxStoredReports) }
    private val store by storeLazy
    private val reportsLazy = lazy { ReportFactory(env, breadcrumbs, { HashMap(customKeys) }, { foreground }, sessionStartMs) }
    private val reports by reportsLazy
    private val uploader by lazy { Uploader(config.endpoint, config.apiKey, store) { SystemClock.uptimeMillis() } }

    // The main thread starts this thread but never waits for it; the thread runs the background
    // half of init itself once its Looper is ready.
    private val mainInitDone = CountDownLatch(1)
    private val ioThread = object : HandlerThread("blackbox-io", Process.THREAD_PRIORITY_BACKGROUND) {
        override fun onLooperPrepared() {
            try {
                mainInitDone.await() // Everything init did on the main thread is visible after this.
            } catch (_: InterruptedException) {
                return
            }
            initInBackground()
        }
    }
    private val io: Handler by lazy { Handler(ioThread.looper) }

    val leakWatcher: LeakWatcher? by lazy {
        if (config.leakDetection) LeakWatcher(io, config.leakWatchDelayMs) { onLeak(it) } else null
    }

    // Asking ActivityManager whether this is a foreground launch is a Binder call that took ~35 ms
    // on the main thread during cold starts (system_server is busy starting the app). Instead, a
    // message is posted to the main thread during init: when the process was started to show an
    // Activity, the system has already queued that Activity's launch, so it is created before
    // the message runs. The importance query still runs, off the main thread, for the session report.
    @Volatile private var firstPostRan = false
    private val startup = StartupTracker(processStartUptimeMs(), { !firstPostRan }, initStartUptimeMs)
    private var watchdog: AnrWatchdog? = null
    private var jank: JankMonitor? = null

    var initDurationMicros: Long = 0
        private set

    val initPhasesMicros: Map<String, Long> get() = phases

    private fun installOnMainThread() {
        CrashHandler(sessionId, reportsLazy, storeLazy).install()
        val callbacks = Callbacks()
        app.registerActivityLifecycleCallbacks(callbacks)
        app.registerComponentCallbacks(callbacks)
        if (config.anrWatchdog) {
            watchdog = AnrWatchdog(config.anrThresholdMs, WATCHDOG_INTERVAL_MS) { onHang(it) }.also { it.start() }
        }
        if (config.jankMonitoring && Build.VERSION.SDK_INT >= 24) {
            val frames = HandlerThread("blackbox-frames", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
            val sampled = ThreadLocalRandom.current().nextDouble() < config.jankSampleRate
            jank = JankMonitor(lazy { Handler(frames.looper) }, sampled, { stats, visitMs -> onScreenVisit(stats, visitMs) }, { screen, end -> onFirstFrame(screen, end) })
        }
        breadcrumb("app", "session started")
    }

    /** Work that must not delay app startup, on the SDK's background thread. */
    private fun initInBackground() {
        Trace.beginSection("Blackbox.backgroundInit")
        try {
            nativeDir.mkdirs()
            if (config.nativeCrashes && NativeBridge.load()) {
                NativeBridge.install(File(nativeDir, "native-$sessionId.txt").path, sessionId)
                for (b in breadcrumbs.snapshot()) NativeBridge.pushBreadcrumb("${b.timeMs} ${b.category}: ${b.message}")
            }
            processNativeCrashFiles()
            val firstRun = !stateFile.exists()
            val state = SessionState.load(stateFile)
            if (firstRun) state.lastExitTimestampMs = System.currentTimeMillis()
            if (Build.VERSION.SDK_INT >= 30) reportExitReasons(state)
            state.record(SessionRecord(sessionId, env.pid, sessionStartMs))
            state.save(stateFile)
            write(reports.create(ReportTypes.SESSION, sessionId, createdAtMs = sessionStartMs, includeContext = false) { w ->
                w.name("coldStartCandidate").value(isForegroundLaunch())
                w.name("sdkInitMicros").value(initDurationMicros)
            })
            upload()
        } catch (t: Throwable) {
            Log.w(TAG, "Background initialization failed", t)
        } finally {
            Trace.endSection()
        }
    }

    private fun processNativeCrashFiles() {
        val files = nativeDir.listFiles { f -> f.name.startsWith("native-") && f.name.endsWith(".txt") && !f.name.contains(sessionId) }
            ?: return
        for (file in files) {
            val crash = runCatching { NativeCrashParser.parse(file.readText()) }.getOrNull()
            if (crash != null) {
                write(reports.create(ReportTypes.NATIVE_CRASH, crash.sessionId ?: "unknown", createdAtMs = crash.timestampMs, includeContext = false) { w ->
                    crash.writePayload(w)
                })
            }
            file.delete()
        }
    }

    private fun reportExitReasons(state: SessionState) {
        if (Build.VERSION.SDK_INT < 30) return
        for (record in ExitReasons.collect(app, state, MAX_TRACE_BYTES)) {
            write(reports.create(ReportTypes.APP_EXIT, record.sessionId ?: "unknown", createdAtMs = record.info.timestamp, includeContext = false) { w ->
                ExitReasons.write(w, record, sessionId)
            })
        }
    }

    fun breadcrumb(category: String, message: String) {
        val now = System.currentTimeMillis()
        breadcrumbs.add(category, message, now)
        if (NativeBridge.loaded) {
            try {
                NativeBridge.pushBreadcrumb("$now $category: $message")
            } catch (_: Throwable) {
            }
        }
    }

    fun setCustomKey(key: String, value: String?) {
        val k = key.take(64)
        if (value == null) {
            customKeys.remove(k)
        } else if (customKeys.size < MAX_CUSTOM_KEYS || customKeys.containsKey(k)) {
            customKeys[k] = value.take(256)
        }
    }

    fun recordNonFatal(throwable: Throwable) {
        val thread = Thread.currentThread()
        io.post {
            write(reports.create(ReportTypes.NON_FATAL, sessionId) { w ->
                w.name("thread").beginObject().name("name").value(thread.name).name("main").value(thread === mainThread).endObject()
                w.name("exception")
                Stacks.writeThrowable(w, throwable)
            })
        }
    }

    fun requestUpload() {
        io.post { upload() }
    }

    private fun upload() {
        Trace.beginSection("Blackbox.upload")
        try {
            uploader.uploadPending()
        } catch (t: Throwable) {
            Log.w(TAG, "Upload failed", t)
        } finally {
            Trace.endSection()
        }
    }

    private fun onHang(event: AnrWatchdog.HangEvent) {
        write(reports.create(ReportTypes.APP_HANG, sessionId, id = event.id, createdAtMs = event.startedAtMs) { w ->
            w.name("blockedMs").value(event.blockedMs)
            w.name("thresholdMs").value(config.anrThresholdMs)
            w.name("ongoing").value(event.ongoing)
            w.name("mainThreadState").value(event.mainThreadState)
            w.name("mainThreadSamples").beginArray()
            for (sample in event.samples) Stacks.writeFrames(w, sample)
            w.endArray()
            event.threads?.let {
                w.name("threads")
                Stacks.writeThreads(w, it, skip = mainThread, mainThread = mainThread)
            }
        })
    }

    private fun onScreenVisit(stats: FrameStats, visitMs: Long) {
        if (stats.frames < MIN_FRAMES_PER_VISIT) return
        write(reports.create(ReportTypes.JANK, sessionId, includeContext = false) { w -> stats.write(w, visitMs) })
    }

    private fun onFirstFrame(screen: String, frameEndUptimeMs: Long) {
        val record = startup.onFirstFrame(screen, frameEndUptimeMs) ?: return
        io.post {
            write(reports.create(ReportTypes.STARTUP, sessionId, includeContext = false) { w ->
                w.name("startType").value(record.type)
                w.name("durationMs").value(record.durationMs)
                w.name("activity").value(record.activity)
                w.name("sdkInitMicros").value(initDurationMicros)
                w.name("processStartToSdkInitMs").value(record.processStartToSdkInitMs)
            })
        }
    }

    private fun onLeak(leak: LeakInfo) {
        write(reports.create(ReportTypes.LEAK, sessionId) { w ->
            w.name("className").value(leak.className)
            w.name("description").value(leak.description)
            w.name("retainedMs").value(leak.retainedMs)
        })
    }

    private fun onForegroundChanged(value: Boolean) {
        foreground = value
        watchdog?.setForeground(value)
        breadcrumb("app", if (value) "foreground" else "background")
        // Uploading when the user leaves batches network use instead of waking the radio per report.
        if (!value) requestUpload()
    }

    private fun write(report: Report) {
        try {
            store.write(report)
        } catch (t: Throwable) {
            Log.w(TAG, "Could not store ${report.type} report", t)
        }
    }

    private fun isForegroundLaunch(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    private fun processStartUptimeMs(): Long =
        if (Build.VERSION.SDK_INT >= 33) Process.getStartRequestedUptimeMillis() else Process.getStartUptimeMillis()

    private inner class Callbacks : Application.ActivityLifecycleCallbacks, ComponentCallbacks2 {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            breadcrumb("lifecycle", "${activity.javaClass.simpleName} created")
            startup.onActivityCreated(activity.javaClass.name, savedInstanceState != null, startedActivities == 0, SystemClock.uptimeMillis())
        }

        override fun onActivityStarted(activity: Activity) {
            if (startedActivities++ == 0) onForegroundChanged(true)
        }

        override fun onActivityResumed(activity: Activity) {
            breadcrumb("lifecycle", "${activity.javaClass.simpleName} resumed")
            jank?.onResumed(activity)
        }

        override fun onActivityPaused(activity: Activity) {
            jank?.onPaused(activity)
            breadcrumb("lifecycle", "${activity.javaClass.simpleName} paused")
        }

        override fun onActivityStopped(activity: Activity) {
            if (startedActivities > 0 && --startedActivities == 0) onForegroundChanged(false)
        }

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

        override fun onActivityDestroyed(activity: Activity) {
            breadcrumb("lifecycle", "${activity.javaClass.simpleName} destroyed")
            leakWatcher?.watch(activity, "${activity.javaClass.name} received onDestroy()")
        }

        override fun onTrimMemory(level: Int) {
            breadcrumb("memory", "onTrimMemory(${trimLevelName(level)})")
        }

        override fun onConfigurationChanged(newConfig: Configuration) = Unit

        @Deprecated("Superseded by onTrimMemory")
        override fun onLowMemory() {
            breadcrumb("memory", "onLowMemory")
        }
    }

    companion object {
        private const val TAG = "Blackbox"
        private const val WATCHDOG_INTERVAL_MS = 500L
        private const val MAX_TRACE_BYTES = 512 * 1024
        private const val MAX_CUSTOM_KEYS = 64
        private const val MIN_FRAMES_PER_VISIT = 10

        fun start(app: Application, config: BlackboxConfig): Core {
            Trace.beginSection("Blackbox.init")
            try {
                val start = System.nanoTime()
                val core = Core(app, config, SystemClock.uptimeMillis())
                core.phases["construct"] = (System.nanoTime() - start) / 1_000
                core.phase("install") { core.installOnMainThread() }
                Handler(Looper.getMainLooper()).post { core.firstPostRan = true }
                core.phase("ioThread") { core.ioThread.start() }
                core.initDurationMicros = (System.nanoTime() - start) / 1_000
                core.mainInitDone.countDown()
                if (Log.isLoggable(TAG, Log.DEBUG)) {
                    Log.d(TAG, "init took ${core.initDurationMicros} us on the main thread: ${core.phases.entries.joinToString { "${it.key} ${it.value} us" }}")
                }
                return core
            } finally {
                Trace.endSection()
            }
        }

        fun trimLevelName(level: Int): String = when (level) {
            5 -> "RUNNING_MODERATE"
            10 -> "RUNNING_LOW"
            15 -> "RUNNING_CRITICAL"
            20 -> "UI_HIDDEN"
            40 -> "BACKGROUND"
            60 -> "MODERATE"
            80 -> "COMPLETE"
            else -> "LEVEL_$level"
        }
    }
}
