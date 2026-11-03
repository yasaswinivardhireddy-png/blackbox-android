package io.github.yasaswini.blackbox.sample

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** Registers itself with a process-wide listener list and never unregisters, then finishes. */
class LeakActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "Promotions" })
        PromotionBus.listeners.add { title = it } // Bug: the lambda captures this Activity forever.
        window.decorView.postDelayed({ finish() }, 300)
    }
}

object PromotionBus {
    val listeners = ArrayList<(String) -> Unit>()
}
