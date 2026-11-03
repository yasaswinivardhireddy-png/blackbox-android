package io.github.yasaswini.blackbox.internal

internal class Breadcrumb(val timeMs: Long, val category: String, val message: String)

/** Fixed-size ring buffer of recent events. Adding is O(1) and allocation-light. */
internal class Breadcrumbs(private val capacity: Int = 64) {
    private val times = LongArray(capacity)
    private val categories = arrayOfNulls<String>(capacity)
    private val messages = arrayOfNulls<String>(capacity)
    private var next = 0
    private var size = 0

    @Synchronized
    fun add(category: String, message: String, timeMs: Long = System.currentTimeMillis()) {
        times[next] = timeMs
        categories[next] = category.take(MAX_CATEGORY)
        messages[next] = message.take(MAX_MESSAGE)
        next = (next + 1) % capacity
        if (size < capacity) size++
    }

    /** Oldest first. */
    @Synchronized
    fun snapshot(): List<Breadcrumb> {
        val result = ArrayList<Breadcrumb>(size)
        val start = (next - size + capacity) % capacity
        for (i in 0 until size) {
            val index = (start + i) % capacity
            result.add(Breadcrumb(times[index], categories[index]!!, messages[index]!!))
        }
        return result
    }

    private companion object {
        const val MAX_CATEGORY = 32
        const val MAX_MESSAGE = 200
    }
}
