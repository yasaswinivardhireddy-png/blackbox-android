package io.github.yasaswini.blackbox.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ReportStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun report(type: String, id: String, at: Long, size: Int = 10) =
        Report(id, type, at, "{\"id\":\"$id\",\"pad\":\"${"x".repeat(size)}\"}")

    @Test
    fun storesReportsAtomicallyInChronologicalOrder() {
        val store = ReportStore(tmp.newFolder("reports"))
        store.write(report("jank", "b", 2_000))
        store.write(report("jvm_crash", "a", 1_000))
        assertEquals(listOf("a", "b"), store.pending().map { ReportStore.idOf(it.name) })
        assertEquals(listOf("jvm_crash", "jank"), store.pending().map { ReportStore.typeOf(it.name) })
        assertFalse(store.pending().any { it.name.endsWith(".tmp") })
    }

    @Test
    fun rewritingAReportWithTheSameIdReplacesIt() {
        val store = ReportStore(tmp.newFolder("reports"))
        store.write(Report("hang1", "app_hang", 5_000, "{\"blockedMs\":2000}"))
        store.write(Report("hang1", "app_hang", 5_000, "{\"blockedMs\":9000}"))
        assertEquals(1, store.count())
        assertEquals("{\"blockedMs\":9000}", store.pending().single().readText())
    }

    @Test
    fun dropsLowPriorityReportsFirstWhenFull() {
        val store = ReportStore(tmp.newFolder("reports"), maxFiles = 3)
        store.write(report("jvm_crash", "crash", 1))
        store.write(report("jank", "jank1", 2))
        store.write(report("session", "session1", 3))
        store.write(report("jank", "jank2", 4))
        store.write(report("native_crash", "native", 5))
        assertEquals(listOf("crash", "session1", "native"), store.pending().map { ReportStore.idOf(it.name) })
    }
}

class UploadBatchTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun buildsOneJsonDocumentFromStoredReports() {
        val store = ReportStore(tmp.newFolder("reports"))
        store.write(Report("a", "jank", 1, "{\"id\":\"a\"}"))
        store.write(Report("b", "leak", 2, "{\"id\":\"b\"}"))
        val batch = Batch.build(store.pending(), maxCount = 10, maxBytes = 10_000, sdk = "test/1")
        assertEquals("""{"sdk":"test/1","reports":[{"id":"a"},{"id":"b"}]}""", batch.body)
        assertEquals(listOf("a", "b"), batch.ids)
    }

    @Test
    fun respectsCountAndSizeLimitsButAlwaysTakesOne() {
        val store = ReportStore(tmp.newFolder("reports"))
        for (i in 1..5) store.write(Report("r$i", "jank", i.toLong(), "{\"pad\":\"${"x".repeat(100)}\"}"))
        assertEquals(2, Batch.build(store.pending(), 2, 10_000, "s").ids.size)
        assertEquals(1, Batch.build(store.pending(), 10, 50, "s").ids.size)
        assertEquals(2, Batch.build(store.pending(), 10, 250, "s").ids.size)
    }

    @Test
    fun parsesAcceptedAndRejectedIds() {
        val body = """{"accepted":["a1","b2"],"rejected":[{"id":"c3","error":"bad schema"}],"duplicates":0}"""
        assertEquals(listOf("a1", "b2"), IngestResponse.accepted(body))
        assertEquals(listOf("c3"), IngestResponse.rejected(body))
        assertTrue(IngestResponse.accepted("{}").isEmpty())
    }

    @Test
    fun backsOffExponentiallyWithJitterUpToACap() {
        val backoff = Backoff(baseMs = 1_000, maxMs = 8_000, random = { 1.0 })
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 8_000L), (1..5).map { backoff.nextDelayMs() })
        backoff.reset()
        assertEquals(0, backoff.failures)
        val jittered = Backoff(baseMs = 1_000, maxMs = 8_000, random = { 0.0 })
        assertEquals(500L, jittered.nextDelayMs())
    }
}

class StacksTest {
    private fun crash(): Throwable = try {
        try {
            error("inner failure")
        } catch (e: IllegalStateException) {
            throw RuntimeException("outer failure", e)
        }
    } catch (e: RuntimeException) {
        e
    }

    @Test
    fun serializesExceptionsWithCauses() {
        val w = JsonWriter()
        Stacks.writeThrowable(w, crash())
        val json = w.toString()
        assertTrue(json.startsWith("""{"type":"java.lang.RuntimeException","message":"outer failure","frames":[{"c":"io.github.yasaswini.blackbox.internal.StacksTest""""))
        assertTrue(json.contains(""""cause":{"type":"java.lang.IllegalStateException","message":"inner failure""""))
    }

    @Test
    fun capsDeepStacks() {
        fun recurse(n: Int): Throwable = if (n == 0) Exception("deep") else recurse(n - 1)
        val deep = recurse(200)
        val w = JsonWriter()
        Stacks.writeThrowable(w, deep)
        val frames = Regex("\"c\":").findAll(w.toString()).count()
        assertEquals(Stacks.MAX_FRAMES, frames)
        assertTrue(w.toString().contains("\"omittedFrames\":"))
    }
}
