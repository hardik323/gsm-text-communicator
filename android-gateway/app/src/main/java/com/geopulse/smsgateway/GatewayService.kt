package com.geopulse.smsgateway

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Foreground service that polls the bot for queued SMS, sends them through the
 * SIM and reports the result. Incoming SMS are handled by [SmsReceiver].
 */
class GatewayService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.notification_waiting)))
        if (loop?.isActive != true) {
            loop = scope.launch { runLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun runLoop() {
        val prefs = Prefs(applicationContext)
        while (coroutineContext.isActive) {
            if (!prefs.isConfigured()) {
                delay(3_000)
                continue
            }

            val api = GatewayApi(prefs.serverUrl, prefs.token)
            var handledWork = false
            try {
                val sms = api.claimOutbox()
                if (sms != null) {
                    handledWork = true
                    sendAndReport(api, sms)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Gateway poll failed: ${t.message}")
            }

            // Drain the queue quickly, then idle at the configured interval.
            if (!handledWork) {
                delay(prefs.pollSeconds.coerceIn(2, 300) * 1_000L)
            }
        }
    }

    private suspend fun sendAndReport(api: GatewayApi, sms: OutboundSms) = withContext(Dispatchers.IO) {
        try {
            SmsSender.send(sms.to, sms.body)
            Log.i(TAG, "Sent SMS for ${sms.requestId} to ${sms.to}")
            api.reportResult(sms.requestId, "sent")
            updateNotification(getString(R.string.notification_sent, sms.to))
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to send SMS for ${sms.requestId}: ${t.message}")
            try {
                api.reportResult(sms.requestId, "failed", t.message)
            } catch (reportError: Throwable) {
                Log.w(TAG, "Could not report failure: ${reportError.message}")
            }
            updateNotification(getString(R.string.notification_failed, t.message ?: "unknown"))
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        const val CHANNEL_ID = "gateway"
        private const val NOTIFICATION_ID = 1
        private const val TAG = "GatewayService"

        @Volatile
        var running: Boolean = false
            private set
    }
}
