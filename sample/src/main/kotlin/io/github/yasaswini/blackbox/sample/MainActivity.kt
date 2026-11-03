package io.github.yasaswini.blackbox.sample

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.github.yasaswini.blackbox.Blackbox

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
        // `adb shell am start -n <pkg>/.MainActivity --es scenario anr_lock` runs a scenario unattended.
        intent.getStringExtra(EXTRA_SCENARIO)?.let { key ->
            window.decorView.postDelayed({ Scenarios.run(this, key) }, 1_000)
        }
    }

    private fun buildContent(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            background = rounded(Color.parseColor("#0B2545"), 16)
        }
        header.addView(text("Blackbox", 26f, Color.WHITE, bold = true))
        header.addView(text("Crash, ANR and performance flight recorder", 15f, Color.parseColor("#CBD5E1")))
        header.addView(
            text(
                "Session ${Blackbox.sessionId?.take(8)}  ·  init ${"%.2f".format(Blackbox.initDurationMicros / 1000.0)} ms on the main thread",
                13f,
                Color.parseColor("#94A3B8"),
            ).apply { setPadding(0, dp(10), 0, 0) },
        )
        column.addView(header)
        column.addView(text("Trigger a real failure. Reports upload on the next launch or when the app goes to the background.", 14f, Color.parseColor("#475569")).apply {
            setPadding(dp(4), dp(16), dp(4), dp(8))
        })
        for (scenario in Scenarios.all) column.addView(card(scenario))
        return ScrollView(this).apply {
            fitsSystemWindows = true
            setBackgroundColor(Color.parseColor("#F3F5F7"))
            addView(column)
        }
    }

    private fun card(scenario: Scenarios.Scenario): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(12), dp(12))
            background = rounded(Color.WHITE, 12)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(10)
            }
        }
        val labels = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        labels.addView(text(scenario.title, 16f, Color.parseColor("#0F172A"), bold = true))
        labels.addView(text(scenario.description, 13f, Color.parseColor("#64748B")))
        card.addView(labels)
        card.addView(Button(this).apply {
            text = "Run"
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = rounded(Color.parseColor("#0E7490"), 10)
            contentDescription = "Run ${scenario.title}"
            setOnClickListener { Scenarios.run(this@MainActivity, scenario.key) }
        })
        return card
    }

    private fun text(value: String, sizeSp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = value
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun rounded(color: Int, radiusDp: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radiusDp).toFloat()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val EXTRA_SCENARIO = "scenario"
    }
}
