package com.geopulse.smsgateway

import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

data class OutboundSms(val requestId: String, val to: String, val body: String)

data class InboundSms(
    val from: String,
    val body: String,
    val receivedAt: Long,
    val messageId: String,
)

/** Minimal JSON-over-HTTP client for the bot's gateway API. */
class GatewayApi(serverUrl: String, private val token: String) {

    private val base = serverUrl.trim().trimEnd('/')

    private fun post(path: String, body: JSONObject): JSONObject {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("x-gateway-token", token)

            connection.outputStream.use { out ->
                out.write(body.toString().toByteArray(Charsets.UTF_8))
            }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()

            if (code !in 200..299) {
                throw IllegalStateException("HTTP $code: ${text.take(200)}")
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    /** Asks the server for the next queued SMS. Returns null when the queue is empty. */
    fun claimOutbox(): OutboundSms? {
        val sms = post("/gateway/outbox/claim", JSONObject()).optJSONObject("sms") ?: return null
        return OutboundSms(
            requestId = sms.optString("requestId"),
            to = sms.optString("to"),
            body = sms.optString("body"),
        )
    }

    fun reportResult(requestId: String, status: String, error: String? = null) {
        val payload = JSONObject().apply {
            put("requestId", requestId)
            put("status", status)
            if (error != null) put("error", error.take(300))
        }
        post("/gateway/outbox/result", payload)
    }

    fun reportInbound(sms: InboundSms) {
        val payload = JSONObject().apply {
            put("from", sms.from)
            put("body", sms.body)
            put("receivedAt", sms.receivedAt)
            put("messageId", sms.messageId)
        }
        post("/gateway/inbound", payload)
    }
}
