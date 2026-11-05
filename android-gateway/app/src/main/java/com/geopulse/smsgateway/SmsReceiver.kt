package com.geopulse.smsgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Receives every incoming SMS and forwards it to the bot so that it can be
 * matched with the Telegram chat that asked for it.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        val from = messages[0].displayOriginatingAddress ?: return
        val body = messages.joinToString(separator = "") { it.displayMessageBody.orEmpty() }
        val receivedAt = messages[0].timestampMillis.takeIf { it > 0 } ?: System.currentTimeMillis()

        // Stable identity for de-duplication on the server.
        val messageId = "$from|$receivedAt|${body.hashCode()}"

        val prefs = Prefs(context)
        if (!prefs.isConfigured()) {
            Log.w(TAG, "Inbound SMS from $from ignored: gateway is not configured")
            return
        }

        // onReceive must return fast; hand the network call to a worker thread.
        val pendingResult = goAsync()
        Thread {
            try {
                GatewayApi(prefs.serverUrl, prefs.token)
                    .reportInbound(InboundSms(from, body, receivedAt, messageId))
                Log.i(TAG, "Forwarded inbound SMS from $from")
            } catch (t: Throwable) {
                Log.w(TAG, "Could not forward inbound SMS: ${t.message}")
            } finally {
                pendingResult.finish()
            }
        }.start()
    }

    private companion object {
        const val TAG = "SmsReceiver"
    }
}
