package io.github.yasaswini.blackbox.sample

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import io.github.yasaswini.blackbox.Blackbox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread

/** Real, reproducible failures. Each mirrors a bug class that shows up in production apps. */
object Scenarios {
    class Scenario(val key: String, val title: String, val description: String)

    val all = listOf(
        Scenario("jvm_crash", "Uncaught exception", "Checkout throws IllegalStateException for an empty cart."),
        Scenario("native_crash", "Native crash (SIGSEGV)", "C++ applies a discount to an order that is missing."),
        Scenario("native_abort", "Native abort (FORTIFY)", "strcpy overflows an 8-byte buffer and bionic aborts."),
        Scenario("anr_lock", "ANR: lock contention", "The main thread waits for a lock a background refresh holds."),
        Scenario("anr_io", "ANR: disk I/O on main thread", "Receipts are written and fsync'd on the main thread."),
        Scenario("race", "Race condition (coroutines)", "Two coroutines share an unsynchronized ArrayList."),
        Scenario("oom", "Out of memory", "An image cache grows until the Java heap is exhausted."),
        Scenario("jank", "Janky screen", "onDraw does 40 ms of work per frame, with one 800 ms stall."),
        Scenario("leak", "Activity leak", "A static listener list keeps a destroyed Activity alive."),
        Scenario("non_fatal", "Non-fatal error", "A declined payment is reported without crashing."),
    )

    fun run(activity: Activity, key: String) {
        Blackbox.breadcrumb("scenario $key", "ui")
        when (key) {
            "jvm_crash" -> CheckoutService().submit(Cart(emptyList()))
            "native_crash" -> NativeCrashes.applyDiscountToMissingOrder()
            "native_abort" -> NativeCrashes.printReceiptLabel("SKU-2026-000123456")
            "anr_lock" -> InventoryRepository().refreshThenCount()
            "anr_io" -> ReceiptArchive(activity).saveAllOnMainThread()
            "race" -> OrderFeed().startRacingCoroutines()
            "oom" -> ImageCache().fillForever()
            "jank" -> activity.startActivity(Intent(activity, JankActivity::class.java))
            "leak" -> activity.startActivity(Intent(activity, LeakActivity::class.java))
            "non_fatal" -> PaymentClient().chargeAndReport()
        }
    }
}

class Cart(val items: List<String>)

class CheckoutService {
    fun submit(cart: Cart): String {
        check(cart.items.isNotEmpty()) { "Cannot submit an empty cart" }
        return "order-1"
    }
}

class InventoryRepository {
    private val lock = Any()

    fun refreshThenCount(): Int {
        thread(name = "inventory-refresh") {
            synchronized(lock) {
                // Bug: slow network work while holding the lock the UI also needs.
                SystemClock.sleep(30_000)
            }
        }
        SystemClock.sleep(200)
        return countOnMainThread()
    }

    private fun countOnMainThread(): Int = synchronized(lock) { 0 }
}

class ReceiptArchive(private val context: Context) {
    fun saveAllOnMainThread() {
        val chunk = ByteArray(1024 * 1024) { it.toByte() }
        val file = File(context.cacheDir, "receipts.bin")
        val until = SystemClock.uptimeMillis() + 30_000
        // Bug: synchronous disk writes and fsync on the UI thread.
        while (SystemClock.uptimeMillis() < until) {
            FileOutputStream(file).use { out ->
                repeat(8) { out.write(chunk) }
                out.fd.sync()
            }
        }
    }
}

class OrderFeed {
    private val orders = ArrayList<Int>()

    fun startRacingCoroutines() {
        val scope = CoroutineScope(Dispatchers.Default)
        scope.launch {
            var i = 0
            while (true) {
                orders.add(i++)
                if (orders.size > 500) orders.clear()
            }
        }
        scope.launch {
            while (true) {
                var total = 0L
                // Bug: iterating while the other coroutine mutates the list.
                for (order in orders) total += order
            }
        }
    }
}

class ImageCache {
    private val bitmaps = ArrayList<ByteArray>()

    fun fillForever() {
        while (true) bitmaps.add(ByteArray(8 * 1024 * 1024))
    }
}

class PaymentDeclinedException(message: String) : Exception(message)

class PaymentClient {
    fun chargeAndReport() {
        try {
            throw PaymentDeclinedException("Card declined: insufficient funds (issuer code 51)")
        } catch (e: PaymentDeclinedException) {
            Blackbox.recordNonFatal(e)
        }
    }
}
