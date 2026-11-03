package io.github.yasaswini.blackbox.internal

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPOutputStream
import kotlin.math.min

/** A gzip-ready batch of stored reports. */
internal class Batch(val files: List<File>, val ids: List<String>, val body: String) {
    fun filesFor(ids: Collection<String>): List<File> {
        val wanted = ids.toHashSet()
        return files.filter { ReportStore.idOf(it.name) in wanted }
    }

    companion object {
        /** Takes reports oldest first until [maxCount] or [maxBytes] of JSON is reached. */
        fun build(files: List<File>, maxCount: Int, maxBytes: Int, sdk: String): Batch {
            val taken = ArrayList<File>()
            val ids = ArrayList<String>()
            val body = StringBuilder(4096).append("{\"sdk\":\"").append(sdk).append("\",\"reports\":[")
            var bytes = 0
            for (f in files) {
                if (taken.size >= maxCount) break
                val json = try {
                    f.readText(Charsets.UTF_8)
                } catch (_: IOException) {
                    continue
                }
                if (taken.isNotEmpty() && bytes + json.length > maxBytes) break
                if (taken.isNotEmpty()) body.append(',')
                body.append(json)
                bytes += json.length
                taken.add(f)
                ids.add(ReportStore.idOf(f.name))
            }
            body.append("]}")
            return Batch(taken, ids, body.toString())
        }
    }
}

/** Reads `"accepted":["id",...]` and `"rejected":[{"id":"..."}]` from the ingest response. */
internal object IngestResponse {
    private val ID = Regex("\"id\"\\s*:\\s*\"([0-9a-zA-Z_-]+)\"")

    fun accepted(body: String): List<String> = stringArray(body, "accepted")

    fun rejected(body: String): List<String> {
        val start = body.indexOf("\"rejected\"")
        if (start < 0) return emptyList()
        val open = body.indexOf('[', start)
        val close = body.indexOf(']', open)
        if (open < 0 || close < 0) return emptyList()
        return ID.findAll(body.substring(open, close)).map { it.groupValues[1] }.toList()
    }

    private fun stringArray(body: String, key: String): List<String> {
        val start = body.indexOf("\"$key\"")
        if (start < 0) return emptyList()
        val open = body.indexOf('[', start)
        val close = body.indexOf(']', open)
        if (open < 0 || close < 0) return emptyList()
        return Regex("\"([0-9a-zA-Z_-]+)\"").findAll(body.substring(open + 1, close)).map { it.groupValues[1] }.toList()
    }
}

/** Exponential backoff with jitter, capped at five minutes. */
internal class Backoff(
    private val baseMs: Long = 10_000,
    private val maxMs: Long = 300_000,
    private val random: () -> Double = { Math.random() },
) {
    var failures: Int = 0
        private set

    fun nextDelayMs(): Long {
        failures++
        val ceiling = min(maxMs.toDouble(), baseMs * Math.pow(2.0, (failures - 1).toDouble()))
        return (ceiling * (0.5 + random() / 2)).toLong()
    }

    fun reset() {
        failures = 0
    }
}

/**
 * Uploads stored reports in gzip batches. Only ever called on the SDK's I/O thread. Reports are
 * deleted only after the server acknowledges them, so nothing is lost when the network drops.
 */
internal class Uploader(
    endpoint: String,
    private val apiKey: String,
    private val store: ReportStore,
    private val clock: () -> Long,
) {
    private val url = endpoint.trimEnd('/') + "/v1/reports"
    private val backoff = Backoff()
    private var retryAtMs = 0L

    fun uploadPending(): Int {
        if (clock() < retryAtMs) return 0
        var accepted = 0
        repeat(MAX_ROUNDS) {
            val pending = store.pending()
            if (pending.isEmpty()) return accepted
            val batch = Batch.build(pending, MAX_BATCH_COUNT, MAX_BATCH_BYTES, ReportFactory.SDK_VERSION)
            if (batch.ids.isEmpty()) return accepted
            val response = try {
                post(batch.body)
            } catch (_: IOException) {
                null
            }
            when {
                response == null || response.code >= 500 || response.code == 429 ||
                    response.code == 401 || response.code == 403 -> {
                    // Transient, throttled or misconfigured: keep the data and retry later.
                    retryAtMs = clock() + backoff.nextDelayMs()
                    return accepted
                }
                response.code in 200..299 -> {
                    val ok = IngestResponse.accepted(response.body)
                    val bad = IngestResponse.rejected(response.body)
                    store.delete(batch.filesFor(ok + bad))
                    accepted += ok.size
                    backoff.reset()
                    if (ok.isEmpty() && bad.isEmpty()) {
                        retryAtMs = clock() + backoff.nextDelayMs()
                        return accepted
                    }
                }
                else -> store.delete(batch.files) // 400/413: this batch can never succeed.
            }
        }
        return accepted
    }

    private class Response(val code: Int, val body: String)

    private fun post(json: String): Response {
        val gz = ByteArrayOutputStream(json.length / 4 + 64)
        GZIPOutputStream(gz).use { it.write(json.toByteArray(Charsets.UTF_8)) }
        val bytes = gz.toByteArray()
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Content-Encoding", "gzip")
            conn.setRequestProperty("Authorization", "Bearer $apiKey")
            conn.outputStream.use { it.write(bytes) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Response(code, body)
        } finally {
            conn.disconnect()
        }
    }

    private companion object {
        const val MAX_ROUNDS = 10
        const val MAX_BATCH_COUNT = 25
        const val MAX_BATCH_BYTES = 768 * 1024
    }
}
