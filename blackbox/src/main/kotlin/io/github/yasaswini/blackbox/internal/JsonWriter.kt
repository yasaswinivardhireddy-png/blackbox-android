package io.github.yasaswini.blackbox.internal

/** Streaming JSON writer with no reflection and no intermediate objects. */
internal class JsonWriter(initialCapacity: Int = 1024) {
    private val out = StringBuilder(initialCapacity)
    private val hasElements = BooleanArray(MAX_DEPTH)
    private var depth = 0
    private var afterName = false

    fun beginObject(): JsonWriter = open('{')
    fun endObject(): JsonWriter = close('}')
    fun beginArray(): JsonWriter = open('[')
    fun endArray(): JsonWriter = close(']')

    fun name(name: String): JsonWriter {
        check(!afterName) { "A value must follow name()" }
        if (hasElements[depth]) out.append(',')
        hasElements[depth] = true
        string(name)
        out.append(':')
        afterName = true
        return this
    }

    fun value(value: String?): JsonWriter {
        beforeValue()
        if (value == null) out.append("null") else string(value)
        return this
    }

    fun value(value: Long): JsonWriter {
        beforeValue()
        out.append(value)
        return this
    }

    fun value(value: Int): JsonWriter {
        beforeValue()
        out.append(value)
        return this
    }

    fun value(value: Boolean): JsonWriter {
        beforeValue()
        out.append(value)
        return this
    }

    fun value(value: Double): JsonWriter {
        beforeValue()
        if (value.isNaN() || value.isInfinite()) out.append("null") else out.append(value)
        return this
    }

    /** Appends an already-serialized JSON value. */
    fun raw(json: String): JsonWriter {
        beforeValue()
        out.append(json)
        return this
    }

    override fun toString(): String = out.toString()

    private fun open(bracket: Char): JsonWriter {
        beforeValue()
        out.append(bracket)
        depth++
        check(depth < MAX_DEPTH) { "JSON is nested too deeply" }
        hasElements[depth] = false
        return this
    }

    private fun close(bracket: Char): JsonWriter {
        check(depth > 0 && !afterName) { "Unbalanced JSON" }
        depth--
        out.append(bracket)
        return this
    }

    private fun beforeValue() {
        if (afterName) {
            afterName = false
            return
        }
        if (depth > 0) {
            if (hasElements[depth]) out.append(',')
            hasElements[depth] = true
        }
    }

    private fun string(s: String) {
        out.append('"')
        for (ch in s) {
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch < ' ' || ch == '\u2028' || ch == '\u2029' -> {
                    val hex = Integer.toHexString(ch.code)
                    out.append("\\u")
                    repeat(4 - hex.length) { out.append('0') }
                    out.append(hex)
                }
                else -> out.append(ch)
            }
        }
        out.append('"')
    }

    private companion object {
        const val MAX_DEPTH = 32
    }
}
