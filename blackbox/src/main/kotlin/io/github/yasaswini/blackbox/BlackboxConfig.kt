package io.github.yasaswini.blackbox

/**
 * Configuration for [Blackbox.init]. Defaults favour low overhead: the ANR watchdog pings the main
 * thread twice a second only while the app is in the foreground, frame metrics are read on a
 * background thread, and reports are uploaded in gzip batches when the app goes to the background.
 */
public class BlackboxConfig @JvmOverloads constructor(
    /** Base URL of the ingestion service, for example `https://telemetry.example.com`. */
    public val endpoint: String,
    /** Key sent as a bearer token with every upload. */
    public val apiKey: String,
    /** Detect main-thread hangs in-process, before the system raises an ANR. */
    public val anrWatchdog: Boolean = true,
    /** How long the main thread may be unresponsive before a hang is recorded. */
    public val anrThresholdMs: Long = 2_000,
    /** Install the native (NDK) signal handler for SIGSEGV, SIGABRT and friends. */
    public val nativeCrashes: Boolean = true,
    /** Record slow and frozen frames per screen using FrameMetrics. */
    public val jankMonitoring: Boolean = true,
    /** Share of sessions (0.0 to 1.0) that report jank statistics. */
    public val jankSampleRate: Double = 1.0,
    /** Report Activities that are still reachable after onDestroy. */
    public val leakDetection: Boolean = true,
    /** How long a destroyed object may stay reachable before it is reported as leaked. */
    public val leakWatchDelayMs: Long = 5_000,
    /** Upper bound on reports kept on disk while offline. */
    public val maxStoredReports: Int = 64,
)
