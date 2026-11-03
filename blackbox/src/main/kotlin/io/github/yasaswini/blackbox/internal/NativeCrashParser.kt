package io.github.yasaswini.blackbox.internal

internal class NativeFrame(
    val pc: String,
    val relPc: String,
    val buildId: String?,
    val symbol: String?,
    val symbolOffset: String,
    val module: String,
)

internal class NativeCrash(
    val sessionId: String?,
    val timestampMs: Long,
    val signal: Int,
    val signalName: String,
    val code: Int,
    val faultAddress: String,
    val pid: Int,
    val tid: Int,
    val thread: String,
    val frames: List<NativeFrame>,
    val breadcrumbs: List<String>,
    val complete: Boolean,
) {
    fun writePayload(w: JsonWriter) {
        w.name("source").value("signal-handler")
        w.name("signal").value(signal)
        w.name("signalName").value(signalName)
        w.name("code").value(code)
        w.name("faultAddress").value(faultAddress)
        w.name("pid").value(pid)
        w.name("tid").value(tid)
        w.name("thread").value(thread)
        w.name("complete").value(complete)
        w.name("frames").beginArray()
        for (f in frames) {
            w.beginObject()
            w.name("pc").value(f.pc)
            w.name("relPc").value(f.relPc)
            w.name("buildId").value(f.buildId)
            w.name("symbol").value(f.symbol)
            w.name("symbolOffset").value(f.symbolOffset)
            w.name("module").value(f.module)
            w.endObject()
        }
        w.endArray()
        w.name("breadcrumbs").beginArray()
        for (b in breadcrumbs) w.value(b)
        w.endArray()
    }
}

/** Parses the line-oriented file written by the native signal handler. */
internal object NativeCrashParser {
    private const val HEADER = "blackbox-native-crash"

    fun parse(text: String): NativeCrash? {
        val lines = text.split('\n')
        if (lines.isEmpty() || !lines[0].startsWith(HEADER)) return null
        var session: String? = null
        var timestamp = 0L
        var signal = 0
        var signalName = "UNKNOWN"
        var code = 0
        var fault = "0x0"
        var pid = 0
        var tid = 0
        var thread = ""
        var complete = false
        val frames = ArrayList<NativeFrame>()
        val crumbs = ArrayList<String>()
        for (line in lines.drop(1)) {
            val key = line.substringBefore(' ')
            val rest = line.substringAfter(' ', "")
            when (key) {
                "session" -> session = rest.trim().ifEmpty { null }
                "timestamp_ms" -> timestamp = rest.trim().toLongOrNull() ?: 0
                "signal" -> {
                    signal = rest.substringBefore(' ').toIntOrNull() ?: 0
                    signalName = rest.substringAfter(' ', "UNKNOWN").trim()
                }
                "code" -> code = rest.trim().toIntOrNull() ?: 0
                "fault_addr" -> fault = rest.trim()
                "pid" -> pid = rest.trim().toIntOrNull() ?: 0
                "tid" -> tid = rest.trim().toIntOrNull() ?: 0
                "thread" -> thread = rest.trim()
                "frame" -> parseFrame(rest)?.let { frames.add(it) }
                "crumb" -> if (rest.isNotBlank()) crumbs.add(rest)
                "end" -> complete = true
            }
        }
        return NativeCrash(session, timestamp, signal, signalName, code, fault, pid, tid, thread, frames, crumbs, complete)
    }

    // frame <pc> <rel_pc> <build_id|-> <symbol|-> <symbol_offset> <module path>
    private fun parseFrame(rest: String): NativeFrame? {
        val parts = rest.split(' ', limit = 6)
        if (parts.size < 6) return null
        return NativeFrame(
            pc = parts[0],
            relPc = parts[1],
            buildId = parts[2].takeIf { it != "-" },
            symbol = parts[3].takeIf { it != "-" },
            symbolOffset = parts[4],
            module = parts[5],
        )
    }
}
