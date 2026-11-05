package com.geopulse.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/** Restarts the gateway service after a reboot (the phone is meant to run headless). */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = Prefs(context)
        if (!prefs.autoStart || !prefs.isConfigured()) return

        ContextCompat.startForegroundService(context, Intent(context, GatewayService::class.java))
    }
}
