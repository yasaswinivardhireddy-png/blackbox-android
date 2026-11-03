package io.github.yasaswini.blackbox.sample

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.SystemClock
import android.view.View

/** Renders for three seconds with expensive frames, then closes itself. */
class JankActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(JankyChartView(this) { finish() })
    }
}

class JankyChartView(context: Context, private val onDone: () -> Unit) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 48f; color = Color.parseColor("#0B2545") }
    private val startUptime = SystemClock.uptimeMillis()
    private var frame = 0

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        frame++
        // Bug: recomputing the whole chart on every frame instead of caching it.
        SystemClock.sleep(if (frame == 20) 800 else 40)
        canvas.drawColor(Color.WHITE)
        canvas.drawText("Rendering sales chart, frame $frame", 40f, 120f, paint)
        if (SystemClock.uptimeMillis() - startUptime < 3_000) invalidate() else post(onDone)
    }
}
