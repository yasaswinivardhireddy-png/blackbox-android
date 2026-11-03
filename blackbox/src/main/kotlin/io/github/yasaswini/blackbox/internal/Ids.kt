package io.github.yasaswini.blackbox.internal

import java.util.concurrent.ThreadLocalRandom

internal object Ids {
    private const val HEX = "0123456789abcdef"

    /**
     * 128-bit random identifier. UUID.randomUUID() would initialize SecureRandom on first use,
     * which can take milliseconds on the main thread; uniqueness, not secrecy, is needed here.
     */
    fun newId(): String {
        val random = ThreadLocalRandom.current()
        val chars = CharArray(32)
        writeHex(random.nextLong(), chars, 0)
        writeHex(random.nextLong(), chars, 16)
        return String(chars)
    }

    private fun writeHex(value: Long, into: CharArray, offset: Int) {
        var v = value
        for (i in 15 downTo 0) {
            into[offset + i] = HEX[(v and 0xF).toInt()]
            v = v ushr 4
        }
    }
}
