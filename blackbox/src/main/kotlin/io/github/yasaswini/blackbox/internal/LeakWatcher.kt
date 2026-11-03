package io.github.yasaswini.blackbox.internal

import android.os.Handler
import android.os.SystemClock
import java.lang.ref.ReferenceQueue
import java.lang.ref.WeakReference

internal class LeakInfo(val className: String, val description: String, val retainedMs: Long)

/**
 * Detects objects that stay reachable after they should be garbage (destroyed Activities, or
 * anything passed to Blackbox.watchForLeak). Each object is held by a WeakReference registered
 * with a ReferenceQueue; if it has not been enqueued after the delay and a forced GC, it leaked.
 */
internal class LeakWatcher(
    private val handler: Handler,
    private val delayMs: Long,
    private val onLeak: (LeakInfo) -> Unit,
) {
    private class Watched(
        referent: Any,
        val key: String,
        val className: String,
        val description: String,
        val watchUptimeMs: Long,
        queue: ReferenceQueue<Any>,
    ) : WeakReference<Any>(referent, queue)

    private val queue = ReferenceQueue<Any>()
    private val watched = HashMap<String, Watched>() // Only touched on [handler]'s thread.

    fun watch(instance: Any, description: String) {
        val ref = Watched(instance, Ids.newId(), instance.javaClass.name, description, SystemClock.uptimeMillis(), queue)
        handler.post { watched[ref.key] = ref }
        handler.postDelayed({ check(ref.key) }, delayMs)
    }

    private fun check(key: String) {
        removeCollected()
        if (key !in watched) return
        forceGc()
        removeCollected()
        val ref = watched.remove(key) ?: return
        if (ref.get() != null) {
            onLeak(LeakInfo(ref.className, ref.description, SystemClock.uptimeMillis() - ref.watchUptimeMs))
        }
    }

    private fun removeCollected() {
        while (true) {
            val ref = queue.poll() as Watched? ?: return
            watched.remove(ref.key)
        }
    }

    private fun forceGc() {
        // Runtime.gc() is only a hint; a short pause lets the reference queue catch up (as LeakCanary does).
        Runtime.getRuntime().gc()
        try {
            Thread.sleep(100)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        System.runFinalization()
    }
}
