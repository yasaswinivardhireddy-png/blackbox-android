package io.github.yasaswini.blackbox.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonWriterTest {
    @Test
    fun writesNestedObjectsAndArraysWithCorrectCommas() {
        val w = JsonWriter()
        w.beginObject()
        w.name("a").value(1)
        w.name("b").beginArray().value("x").value(true).beginObject().name("n").value(null as String?).endObject().endArray()
        w.name("c").beginObject().endObject()
        w.name("d").value(2.5)
        w.endObject()
        assertEquals("""{"a":1,"b":["x",true,{"n":null}],"c":{},"d":2.5}""", w.toString())
    }

    @Test
    fun escapesStringsSafely() {
        val w = JsonWriter().beginObject().name("m").value("quote\" slash\\ nl\n tab\t ctl\u0001 sep\u2028").endObject()
        assertEquals("""{"m":"quote\" slash\\ nl\n tab\t ctl\u0001 sep\u2028"}""", w.toString())
    }

    @Test
    fun writesNonFiniteNumbersAsNull() {
        val w = JsonWriter().beginArray().value(Double.NaN).value(Double.POSITIVE_INFINITY).endArray()
        assertEquals("[null,null]", w.toString())
    }

    @Test
    fun appendsRawJson() {
        val w = JsonWriter().beginArray().raw("""{"x":1}""").raw("[]").endArray()
        assertEquals("""[{"x":1},[]]""", w.toString())
    }
}

class BreadcrumbsTest {
    @Test
    fun keepsTheMostRecentEntriesOldestFirst() {
        val crumbs = Breadcrumbs(capacity = 3)
        for (i in 1..5) crumbs.add("c", "m$i", timeMs = i.toLong())
        assertEquals(listOf("m3", "m4", "m5"), crumbs.snapshot().map { it.message })
        assertEquals(listOf(3L, 4L, 5L), crumbs.snapshot().map { it.timeMs })
    }

    @Test
    fun truncatesLongMessages() {
        val crumbs = Breadcrumbs()
        crumbs.add("category-that-is-way-too-long-for-the-limit", "x".repeat(1000))
        val entry = crumbs.snapshot().single()
        assertEquals(32, entry.category.length)
        assertEquals(200, entry.message.length)
    }
}

class IdsTest {
    @Test
    fun generatesUniqueHexIds() {
        val ids = (1..10_000).map { Ids.newId() }.toSet()
        assertEquals(10_000, ids.size)
        assertTrue(ids.all { it.length == 32 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } })
    }
}
