package com.geopulse.smsgateway

import android.content.Context

/** Simple SharedPreferences wrapper for the gateway configuration. */
class Prefs(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences("gateway", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim()).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_TOKEN, value.trim()).apply()

    var pollSeconds: Int
        get() = prefs.getInt(KEY_POLL_SECONDS, 5)
        set(value) = prefs.edit().putInt(KEY_POLL_SECONDS, value).apply()

    var autoStart: Boolean
        get() = prefs.getBoolean(KEY_AUTO_START, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_START, value).apply()

    fun isConfigured(): Boolean = serverUrl.isNotBlank() && token.isNotBlank()

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val KEY_TOKEN = "token"
        const val KEY_POLL_SECONDS = "poll_seconds"
        const val KEY_AUTO_START = "auto_start"
    }
}
