package com.geopulse.smsgateway

import android.telephony.SmsManager

/** Sends a (possibly multipart) SMS through the SIM of the default SmsManager. */
object SmsSender {

    @Suppress("DEPRECATION")
    fun send(to: String, body: String) {
        require(to.isNotBlank()) { "destination number is empty" }
        require(body.isNotBlank()) { "SMS body is empty" }

        val manager = SmsManager.getDefault()
        val parts = manager.divideMessage(body)
        if (parts == null || parts.size <= 1) {
            manager.sendTextMessage(to, null, body, null, null)
        } else {
            manager.sendMultipartTextMessage(to, null, parts, null, null)
        }
    }
}
