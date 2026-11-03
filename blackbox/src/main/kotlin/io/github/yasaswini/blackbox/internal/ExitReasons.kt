package io.github.yasaswini.blackbox.internal

import android.annotation.TargetApi
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.util.Base64
import java.io.InputStream

internal class ExitRecord(
    val info: ApplicationExitInfo,
    val reasonName: String,
    val sessionId: String?,
    val traceFormat: String?,
    val trace: String?,
    val traceTruncated: Boolean,
)

/**
 * Reads why previous processes died (Android 11+). This confirms ANRs and supplies the system's
 * ANR thread dump, delivers Android 12+ native-crash tombstones, and reveals deaths the app
 * cannot observe itself, such as low-memory kills.
 */
@TargetApi(30)
internal object ExitReasons {
    private val IGNORED = setOf(
        ApplicationExitInfo.REASON_EXIT_SELF,
        ApplicationExitInfo.REASON_USER_REQUESTED,
        ApplicationExitInfo.REASON_USER_STOPPED,
        ApplicationExitInfo.REASON_PERMISSION_CHANGE,
        ApplicationExitInfo.REASON_DEPENDENCY_DIED,
        REASON_PACKAGE_STATE_CHANGE,
        REASON_PACKAGE_UPDATED,
    )

    /** Exits newer than the last processed one, oldest first. Updates [state]. */
    fun collect(context: Context, state: SessionState, maxTraceBytes: Int): List<ExitRecord> {
        val am = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
        val infos = try {
            am.getHistoricalProcessExitReasons(context.packageName, 0, 16)
        } catch (_: RuntimeException) {
            return emptyList()
        }
        val fresh = infos.filter { it.timestamp > state.lastExitTimestampMs }.sortedBy { it.timestamp }
        if (infos.isNotEmpty()) state.lastExitTimestampMs = maxOf(state.lastExitTimestampMs, infos.maxOf { it.timestamp })
        return fresh.filter { it.reason !in IGNORED }.map { info ->
            val session = state.sessionFor(info.pid, info.timestamp)?.id
            when (info.reason) {
                ApplicationExitInfo.REASON_ANR -> {
                    val (bytes, truncated) = readTrace(info, maxTraceBytes)
                    ExitRecord(info, reasonName(info.reason), session, bytes?.let { "anr-text" }, bytes?.toString(Charsets.UTF_8), truncated)
                }
                ApplicationExitInfo.REASON_CRASH_NATIVE -> {
                    val (bytes, truncated) = readTrace(info, maxTraceBytes)
                    val encoded = bytes?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
                    ExitRecord(info, reasonName(info.reason), session, encoded?.let { "tombstone-proto-base64" }, encoded, truncated)
                }
                else -> ExitRecord(info, reasonName(info.reason), session, null, null, false)
            }
        }
    }

    fun write(w: JsonWriter, record: ExitRecord, reportedBySession: String) {
        val info = record.info
        w.name("reason").value(record.reasonName)
        w.name("reasonCode").value(info.reason)
        w.name("exitTimestamp").value(info.timestamp)
        w.name("pid").value(info.pid)
        w.name("processName").value(info.processName)
        w.name("status").value(info.status)
        w.name("importance").value(info.importance)
        w.name("pssKb").value(info.pss)
        w.name("rssKb").value(info.rss)
        w.name("description").value(info.description)
        w.name("exitedSessionId").value(record.sessionId)
        w.name("reportedBySessionId").value(reportedBySession)
        if (record.trace != null) {
            w.name("traceFormat").value(record.traceFormat)
            w.name("trace").value(record.trace)
            w.name("traceTruncated").value(record.traceTruncated)
        }
    }

    private fun readTrace(info: ApplicationExitInfo, max: Int): Pair<ByteArray?, Boolean> =
        try {
            info.traceInputStream?.use { readUpTo(it, max) } ?: (null to false)
        } catch (_: Exception) {
            null to false
        }

    private fun readUpTo(stream: InputStream, max: Int): Pair<ByteArray, Boolean> {
        val buffer = ByteArray(max + 1)
        var total = 0
        while (total < buffer.size) {
            val n = stream.read(buffer, total, buffer.size - total)
            if (n < 0) break
            total += n
        }
        val truncated = total > max
        return buffer.copyOf(minOf(total, max)) to truncated
    }

    fun reasonName(code: Int): String = when (code) {
        0 -> "UNKNOWN"
        1 -> "EXIT_SELF"
        2 -> "SIGNALED"
        3 -> "LOW_MEMORY"
        4 -> "CRASH"
        5 -> "CRASH_NATIVE"
        6 -> "ANR"
        7 -> "INITIALIZATION_FAILURE"
        8 -> "PERMISSION_CHANGE"
        9 -> "EXCESSIVE_RESOURCE_USAGE"
        10 -> "USER_REQUESTED"
        11 -> "USER_STOPPED"
        12 -> "DEPENDENCY_DIED"
        13 -> "OTHER"
        14 -> "FREEZER"
        15 -> "PACKAGE_STATE_CHANGE"
        16 -> "PACKAGE_UPDATED"
        else -> "REASON_$code"
    }
}

// API 34 constants, declared here so they can be compared on any API level.
private const val REASON_PACKAGE_STATE_CHANGE = 15
private const val REASON_PACKAGE_UPDATED = 16
