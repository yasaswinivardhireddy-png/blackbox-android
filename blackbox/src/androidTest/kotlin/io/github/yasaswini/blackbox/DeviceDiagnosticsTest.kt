package io.github.yasaswini.blackbox

import android.app.Application
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.yasaswini.blackbox.internal.AnrWatchdog
import io.github.yasaswini.blackbox.internal.Breadcrumbs
import io.github.yasaswini.blackbox.internal.CrashHandler
import io.github.yasaswini.blackbox.internal.Environment
import io.github.yasaswini.blackbox.internal.LeakInfo
import io.github.yasaswini.blackbox.internal.LeakWatcher
import io.github.yasaswini.blackbox.internal.NativeBridge
import io.github.yasaswini.blackbox.internal.NativeCrashParser
import io.github.yasaswini.blackbox.internal.ReportFactory
import io.github.yasaswini.blackbox.internal.ReportStore
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceDiagnosticsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app: Application get() = instrumentation.targetContext.applicationContext as Application

    // Held strongly on purpose: this is the "leaked" object.
    private var retainedOrder: Order? = null

    private class Order(val id: Int)

    @Test
    fun watchdogReportsABlockedMainThreadWithItsStack() {
        val events = LinkedBlockingQueue<AnrWatchdog.HangEvent>()
        val watchdog = AnrWatchdog(thresholdMs = 500, intervalMs = 100) { events.add(it) }
        watchdog.start()
        watchdog.setForeground(true)
        try {
            instrumentation.runOnMainSync { holdMainThread(1_500) }
            var final: AnrWatchdog.HangEvent? = null
            val deadline = SystemClock.uptimeMillis() + 10_000
            while (final == null && SystemClock.uptimeMillis() < deadline) {
                val event = events.poll(1, TimeUnit.SECONDS) ?: continue
                if (!event.ongoing) final = event
            }
            assertNotNull("the end of the hang was never reported", final)
            val hang = final!!
            assertTrue("blocked ${hang.blockedMs} ms", hang.blockedMs in 1_000..5_000)
            assertTrue("main thread stack was not sampled", hang.samples.any { stack -> stack.any { it.methodName == "holdMainThread" } })
            assertNotNull(hang.mainThreadState)
            assertNotNull(hang.threads)
        } finally {
            watchdog.interrupt()
        }
    }

    @Test
    fun watchdogStaysQuietWhileTheMainThreadIsResponsive() {
        val events = LinkedBlockingQueue<AnrWatchdog.HangEvent>()
        val watchdog = AnrWatchdog(thresholdMs = 500, intervalMs = 100) { events.add(it) }
        watchdog.start()
        watchdog.setForeground(true)
        try {
            repeat(15) { instrumentation.runOnMainSync { SystemClock.sleep(50) }; SystemClock.sleep(50) }
            assertNull(events.poll(500, TimeUnit.MILLISECONDS))
        } finally {
            watchdog.interrupt()
        }
    }

    @Test
    fun leakWatcherReportsOnlyObjectsThatStayReachable() {
        val thread = HandlerThread("leak-test").apply { start() }
        val leaks = LinkedBlockingQueue<LeakInfo>()
        val watcher = LeakWatcher(Handler(thread.looper), delayMs = 300) { leaks.add(it) }
        try {
            retainedOrder = Order(1)
            watcher.watch(retainedOrder!!, "order screen was closed")
            watchUnreachableOrder(watcher)
            val leak = leaks.poll(10, TimeUnit.SECONDS)
            assertNotNull("the retained object was not reported", leak)
            assertEquals(Order::class.java.name, leak!!.className)
            assertTrue(leak.retainedMs >= 300)
            assertNull("a collected object was reported", leaks.poll(2, TimeUnit.SECONDS))
        } finally {
            thread.quitSafely()
            retainedOrder = null
        }
    }

    @Test
    fun crashHandlerPersistsTheCrashBeforeHandingOver() {
        val dir = File(app.cacheDir, "crash-test").apply { deleteRecursively() }
        val store = ReportStore(dir)
        val breadcrumbs = Breadcrumbs().apply { add("ui", "Tapped checkout") }
        val factory = ReportFactory(Environment.capture(app), breadcrumbs, { mapOf("cart" to "3 items") }, { true }, System.currentTimeMillis())
        val handedOver = CountDownLatch(1)
        val handler = CrashHandler("test-session", factory, store, Thread.UncaughtExceptionHandler { _, _ -> handedOver.countDown() })

        handler.uncaughtException(Thread({}, "checkout-worker"), IllegalStateException("Cannot submit an empty cart", NullPointerException("cart")))

        assertTrue(handedOver.await(1, TimeUnit.SECONDS))
        val json = store.pending().single().readText()
        for (expected in listOf("jvm_crash", "Cannot submit an empty cart", "checkout-worker", "java.lang.NullPointerException", "Tapped checkout", "3 items")) {
            assertTrue("missing $expected", json.contains(expected))
        }
    }

    @Test
    fun nativeWriterProducesAParsableReport() {
        assertTrue(NativeBridge.load())
        val file = File(app.cacheDir, "native-selftest.txt").apply { delete() }
        assertTrue(NativeBridge.writeSelfTest(file.path))
        val crash = NativeCrashParser.parse(file.readText())
        assertNotNull(crash)
        assertEquals("SIGTRAP", crash!!.signalName)
        assertTrue(crash.complete)
        val own = crash.frames.filter { it.module.endsWith("libblackbox.so") }
        assertTrue("no frames in libblackbox.so: ${crash.frames.map { it.module }}", own.isNotEmpty())
        assertTrue("build IDs missing", own.all { !it.buildId.isNullOrEmpty() })
        assertTrue("JNI entry point not symbolized", own.any { it.symbol?.contains("writeSelfTest") == true })
    }

    @Test
    fun initIsCheapOnTheMainThread() {
        instrumentation.runOnMainSync {
            Blackbox.init(app, BlackboxConfig(endpoint = "http://127.0.0.1:9", apiKey = "test"))
        }
        val micros = Blackbox.initDurationMicros
        Log.i("BlackboxTest", "Blackbox.init took $micros us on the main thread")
        assertTrue(Blackbox.isInitialized)
        assertTrue("init took $micros us", micros in 1..50_000)
    }

    private fun holdMainThread(ms: Long) {
        SystemClock.sleep(ms)
    }

    private fun watchUnreachableOrder(watcher: LeakWatcher) {
        watcher.watch(Order(2), "temporary order")
    }
}
