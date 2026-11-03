package io.github.yasaswini.blackbox.sample

import android.app.Application
import android.util.Log
import io.github.yasaswini.blackbox.Blackbox
import io.github.yasaswini.blackbox.BlackboxConfig

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Blackbox.init(
            this,
            BlackboxConfig(
                endpoint = BuildConfig.BLACKBOX_ENDPOINT,
                apiKey = "sample-key",
                anrThresholdMs = 2_000,
                leakWatchDelayMs = 3_000,
            ),
        )
        Blackbox.setCustomKey("store", "BLR-042")
        // Read by the end-to-end script to measure initialization cost on the main thread.
        Log.i("BlackboxSample", "Blackbox.init took ${Blackbox.initDurationMicros} us")
    }
}
