package io.github.yasaswini.blackbox.internal

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Durable on-disk queue of reports, one file per report named `<createdAt>-<type>-<id>.json` so a
 * name sort is chronological. Writes are atomic (temp file, fsync, rename): a crash mid-write
 * never leaves a half-written report, and rewriting a report with the same id replaces it.
 */
internal class ReportStore(
    private val dir: File,
    private val maxFiles: Int = 64,
    private val maxBytes: Long = 4L * 1024 * 1024,
) {
    // The directory is created on first write, so constructing the store does no disk I/O.
    @Synchronized
    fun write(report: Report) {
        if (!dir.isDirectory) dir.mkdirs()
        val bytes = report.json.toByteArray(Charsets.UTF_8)
        val tmp = File(dir, "${report.id}.tmp")
        val dest = File(dir, fileName(report))
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        if (!replaceFile(tmp, dest)) {
            tmp.delete()
            throw IOException("Could not store report ${report.id}")
        }
        trim()
    }

    @Synchronized
    fun pending(): List<File> =
        dir.listFiles { f -> f.name.endsWith(SUFFIX) }?.sortedBy { it.name } ?: emptyList()

    fun count(): Int = pending().size

    @Synchronized
    fun delete(files: Collection<File>) {
        for (f in files) f.delete()
    }

    /** Over the limits, drop the lowest-priority, oldest reports first (crashes are kept longest). */
    private fun trim() {
        val files = pending()
        var count = files.size
        var bytes = files.sumOf { it.length() }
        if (count <= maxFiles && bytes <= maxBytes) return
        val victims = files.sortedWith(compareBy({ ReportTypes.priority(typeOf(it.name)) }, { it.name }))
        for (f in victims) {
            if (count <= maxFiles && bytes <= maxBytes) break
            bytes -= f.length()
            count--
            f.delete()
        }
    }

    companion object {
        private const val SUFFIX = ".json"

        fun fileName(report: Report): String = "${report.createdAtMs}-${report.type}-${report.id}$SUFFIX"

        fun idOf(fileName: String): String = fileName.removeSuffix(SUFFIX).substringAfterLast('-')

        fun typeOf(fileName: String): String = fileName.removeSuffix(SUFFIX).substringAfter('-').substringBeforeLast('-')
    }
}

/**
 * rename(2) replaces the target atomically on Android. Some file systems (and Windows, where the
 * JVM unit tests may run) refuse to overwrite, so fall back to delete-then-rename there.
 */
internal fun replaceFile(source: File, target: File): Boolean {
    if (source.renameTo(target)) return true
    target.delete()
    return source.renameTo(target)
}
