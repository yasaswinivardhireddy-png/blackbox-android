package io.github.yasaswini.blackbox.internal

import java.io.File
import java.io.FileOutputStream

/**
 * Small persistent state, stored as text so it can be read without any parser:
 * the newest ApplicationExitInfo already processed, and recent sessions with their pid, which
 * lets an exit reported in a later process be attributed to the session that died.
 */
internal class SessionState(
    var lastExitTimestampMs: Long = 0,
    val sessions: MutableList<SessionRecord> = ArrayList(),
) {
    fun record(session: SessionRecord) {
        sessions.removeAll { it.id == session.id }
        sessions.add(session)
        while (sessions.size > MAX_SESSIONS) sessions.removeAt(0)
    }

    /** The latest session that ran in [pid] and started before [exitTimestampMs]. */
    fun sessionFor(pid: Int, exitTimestampMs: Long): SessionRecord? =
        sessions.filter { it.pid == pid && it.startMs <= exitTimestampMs }.maxByOrNull { it.startMs }

    fun encode(): String = buildString {
        append("lastExitTimestamp=").append(lastExitTimestampMs).append('\n')
        for (s in sessions) append("session=").append(s.id).append(' ').append(s.pid).append(' ').append(s.startMs).append('\n')
    }

    fun save(file: File) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(encode().toByteArray(Charsets.UTF_8))
            out.fd.sync()
        }
        if (!replaceFile(tmp, file)) tmp.delete()
    }

    companion object {
        private const val MAX_SESSIONS = 10

        fun decode(text: String): SessionState {
            val state = SessionState()
            for (line in text.lineSequence()) {
                when {
                    line.startsWith("lastExitTimestamp=") ->
                        state.lastExitTimestampMs = line.substringAfter('=').trim().toLongOrNull() ?: 0
                    line.startsWith("session=") -> {
                        val parts = line.substringAfter('=').trim().split(' ')
                        if (parts.size == 3) {
                            val pid = parts[1].toIntOrNull()
                            val start = parts[2].toLongOrNull()
                            if (pid != null && start != null) state.sessions.add(SessionRecord(parts[0], pid, start))
                        }
                    }
                }
            }
            return state
        }

        fun load(file: File): SessionState =
            if (file.exists()) runCatching { decode(file.readText()) }.getOrDefault(SessionState()) else SessionState()
    }
}

internal data class SessionRecord(val id: String, val pid: Int, val startMs: Long)
