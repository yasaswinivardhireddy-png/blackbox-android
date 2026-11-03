package io.github.yasaswini.blackbox.internal

import android.app.Application
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import java.io.File

/** App and device facts captured once at startup and attached to every report. */
internal class Environment(
    val packageName: String,
    val processName: String,
    val pid: Int,
    val appVersion: String,
    val appBuild: Long,
    val debuggable: Boolean,
    val manufacturer: String,
    val brand: String,
    val model: String,
    val device: String,
    val sdkInt: Int,
    val release: String,
    val abis: List<String>,
    val emulator: Boolean,
) {
    fun writeApp(w: JsonWriter) {
        w.beginObject()
        w.name("id").value(packageName)
        w.name("version").value(appVersion)
        w.name("build").value(appBuild)
        w.name("debuggable").value(debuggable)
        w.name("process").value(processName)
        w.name("pid").value(pid)
        w.endObject()
    }

    fun writeDevice(w: JsonWriter) {
        w.beginObject()
        w.name("manufacturer").value(manufacturer)
        w.name("brand").value(brand)
        w.name("model").value(model)
        w.name("device").value(device)
        w.name("sdkInt").value(sdkInt)
        w.name("release").value(release)
        w.name("abis").beginArray()
        for (abi in abis) w.value(abi)
        w.endArray()
        w.name("emulator").value(emulator)
        w.endObject()
    }

    companion object {
        fun capture(app: Application): Environment {
            var version = "unknown"
            var build = 0L
            try {
                @Suppress("DEPRECATION")
                val info = app.packageManager.getPackageInfo(app.packageName, 0)
                version = info.versionName ?: "unknown"
                build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else {
                    @Suppress("DEPRECATION")
                    info.versionCode.toLong()
                }
            } catch (_: PackageManager.NameNotFoundException) {
            }
            return Environment(
                packageName = app.packageName,
                processName = processName(app),
                pid = Process.myPid(),
                appVersion = version,
                appBuild = build,
                debuggable = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
                manufacturer = Build.MANUFACTURER ?: "unknown",
                brand = Build.BRAND ?: "unknown",
                model = Build.MODEL ?: "unknown",
                device = Build.DEVICE ?: "unknown",
                sdkInt = Build.VERSION.SDK_INT,
                release = Build.VERSION.RELEASE ?: "unknown",
                abis = Build.SUPPORTED_ABIS?.toList() ?: emptyList(),
                emulator = isEmulator(),
            )
        }

        private fun processName(app: Application): String {
            if (Build.VERSION.SDK_INT >= 28) return Application.getProcessName()
            return runCatching { File("/proc/self/cmdline").readText().trim('\u0000', ' ') }
                .getOrNull()?.takeIf { it.isNotEmpty() } ?: app.packageName
        }

        private fun isEmulator(): Boolean {
            val fingerprint = Build.FINGERPRINT ?: ""
            val hardware = Build.HARDWARE ?: ""
            return fingerprint.startsWith("generic") || fingerprint.contains("emulator") ||
                hardware == "ranchu" || hardware == "goldfish" || (Build.MODEL ?: "").startsWith("sdk_gphone")
        }
    }
}
