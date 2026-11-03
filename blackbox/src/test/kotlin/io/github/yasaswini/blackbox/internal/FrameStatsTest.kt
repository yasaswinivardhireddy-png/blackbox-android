package io.github.yasaswini.blackbox.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameStatsTest {
    private val ms = 1_000_000L

    @Test
    fun classifiesSlowAndFrozenFramesAgainstTheRefreshRate() {
        val stats = FrameStats("Checkout", refreshRateHz = 60f)
        stats.add(10 * ms)
        stats.add(16 * ms)
        stats.add(17 * ms) // over the 16.7 ms budget at 60 Hz
        stats.add(120 * ms)
        stats.add(800 * ms) // frozen
        assertEquals(5, stats.frames)
        assertEquals(3, stats.slowFrames)
        assertEquals(1, stats.frozenFrames)
        assertEquals(800.0, stats.worstFrameMs, 0.01)
        assertEquals(listOf(2, 1, 0, 0, 1, 0, 1), stats.buckets.toList())
    }

    @Test
    fun usesTheShorterBudgetOfHighRefreshDisplays() {
        val stats = FrameStats("Feed", refreshRateHz = 120f)
        stats.add(10 * ms) // over 8.3 ms
        stats.add(8 * ms)
        assertEquals(1, stats.slowFrames)
    }

    @Test
    fun prefersThePlatformDeadlineWhenReported() {
        val stats = FrameStats("Feed", refreshRateHz = 60f)
        stats.add(20 * ms, deadlineNs = 33 * ms)
        assertEquals(0, stats.slowFrames)
    }

    @Test
    fun serializesBucketsByUpperBound() {
        val stats = FrameStats("S", 60f)
        stats.add(5 * ms)
        stats.add(900 * ms)
        val w = JsonWriter().beginObject()
        stats.write(w, visitMs = 1500)
        w.endObject()
        val json = w.toString()
        assertEquals(true, json.contains("\"le16\":1"))
        assertEquals(true, json.contains("\"gt700\":1"))
        assertEquals(true, json.contains("\"frozenFrames\":1"))
    }
}

class StartupTrackerTest {
    @Test
    fun measuresColdStartFromProcessStartToFirstFrame() {
        val tracker = StartupTracker(processStartUptimeMs = 1_000, launchedForActivity = { true }, sdkInitStartUptimeMs = 1_150)
        tracker.onActivityCreated("Main", hasSavedState = false, appInBackground = true, nowUptimeMs = 1_300)
        assertNull(tracker.onFirstFrame("Other", 1_500))
        val record = tracker.onFirstFrame("Main", 1_640)!!
        assertEquals("cold", record.type)
        assertEquals(640, record.durationMs)
        assertEquals(150, record.processStartToSdkInitMs)
        assertNull(tracker.onFirstFrame("Main", 2_000))
    }

    @Test
    fun treatsBackgroundStartedProcessesAsWarm() {
        val tracker = StartupTracker(processStartUptimeMs = 0, launchedForActivity = { false }, sdkInitStartUptimeMs = 10)
        tracker.onActivityCreated("Main", hasSavedState = false, appInBackground = true, nowUptimeMs = 60_000)
        val record = tracker.onFirstFrame("Main", 60_250)!!
        assertEquals("warm", record.type)
        assertEquals(250, record.durationMs)
    }

    @Test
    fun recordsWarmStartsWhenReturningFromBackground() {
        val tracker = StartupTracker(0, { true }, 0)
        tracker.onActivityCreated("Main", false, true, 100)
        tracker.onFirstFrame("Main", 400)
        tracker.onActivityCreated("Detail", false, appInBackground = false, nowUptimeMs = 900)
        assertNull(tracker.onFirstFrame("Detail", 950))
        tracker.onActivityCreated("Main", false, appInBackground = true, nowUptimeMs = 5_000)
        assertEquals(180, tracker.onFirstFrame("Main", 5_180)!!.durationMs)
    }
}

class SessionStateTest {
    @Test
    fun roundTripsAndKeepsTheLastTenSessions() {
        val state = SessionState(lastExitTimestampMs = 42)
        for (i in 1..12) state.record(SessionRecord("s$i", 100 + i, i * 1000L))
        val decoded = SessionState.decode(state.encode())
        assertEquals(42, decoded.lastExitTimestampMs)
        assertEquals((3..12).map { "s$it" }, decoded.sessions.map { it.id })
    }

    @Test
    fun attributesAnExitToTheLatestSessionWithThatPid() {
        val state = SessionState()
        state.record(SessionRecord("old", 4242, 1_000))
        state.record(SessionRecord("other", 5000, 2_000))
        state.record(SessionRecord("recent", 4242, 3_000))
        assertEquals("recent", state.sessionFor(4242, 3_500)?.id)
        assertEquals("old", state.sessionFor(4242, 2_500)?.id)
        assertNull(state.sessionFor(9999, 3_500))
    }

    @Test
    fun ignoresCorruptLines() {
        val state = SessionState.decode("lastExitTimestamp=oops\nsession=a b c\nsession=ok 7 9\ngarbage")
        assertEquals(0, state.lastExitTimestampMs)
        assertEquals(listOf("ok"), state.sessions.map { it.id })
    }
}
