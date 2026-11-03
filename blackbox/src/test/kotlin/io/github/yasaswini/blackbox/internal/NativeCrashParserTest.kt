package io.github.yasaswini.blackbox.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeCrashParserTest {
    private val sample = """
        blackbox-native-crash 1
        session 3f2a9c
        timestamp_ms 1762150000123
        signal 11 SIGSEGV
        code 1
        fault_addr 0x8
        pid 4242
        tid 4242
        thread main
        frame 0x7a1b2c3d4e10 0x1e10 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b blackbox_sample_apply_discount 0x10 /data/app/~~x==/io.github.sample-y==/base.apk!/lib/x86_64/libcrashy.so
        frame 0x7a1b2c3d4f20 0x1f1f - - 0x0 /apex/com.android.art/lib64/libart.so
        crumb 1762150000000 lifecycle: MainActivity resumed
        crumb 1762150000100 app: checkout tapped
        end
    """.trimIndent()

    @Test
    fun parsesSignalThreadFramesAndBreadcrumbs() {
        val crash = NativeCrashParser.parse(sample)!!
        assertEquals("3f2a9c", crash.sessionId)
        assertEquals(1762150000123, crash.timestampMs)
        assertEquals(11, crash.signal)
        assertEquals("SIGSEGV", crash.signalName)
        assertEquals("0x8", crash.faultAddress)
        assertEquals("main", crash.thread)
        assertEquals(2, crash.frames.size)
        val top = crash.frames[0]
        assertEquals("0x1e10", top.relPc)
        assertEquals("blackbox_sample_apply_discount", top.symbol)
        assertTrue(top.module.endsWith("lib/x86_64/libcrashy.so"))
        assertNull(crash.frames[1].buildId)
        assertNull(crash.frames[1].symbol)
        assertEquals(listOf("1762150000000 lifecycle: MainActivity resumed", "1762150000100 app: checkout tapped"), crash.breadcrumbs)
        assertTrue(crash.complete)
    }

    @Test
    fun acceptsATruncatedFile() {
        val truncated = sample.substringBefore("crumb")
        val crash = NativeCrashParser.parse(truncated)!!
        assertFalse(crash.complete)
        assertEquals(2, crash.frames.size)
    }

    @Test
    fun rejectsUnrelatedFiles() {
        assertNull(NativeCrashParser.parse("hello\nworld"))
    }

    @Test
    fun serializesPayload() {
        val w = JsonWriter().beginObject()
        NativeCrashParser.parse(sample)!!.writePayload(w)
        w.endObject()
        assertTrue(w.toString().contains(""""signalName":"SIGSEGV""""))
        assertTrue(w.toString().contains(""""buildId":null"""))
    }
}
