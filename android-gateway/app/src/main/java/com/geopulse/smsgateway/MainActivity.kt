package com.geopulse.smsgateway

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.method.ScrollingMovementMethod
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.geopulse.smsgateway.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: Prefs

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refreshStatus() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = Prefs(this)
        binding.serverUrl.setText(prefs.serverUrl)
        binding.token.setText(prefs.token)
        binding.pollSeconds.setText(prefs.pollSeconds.toString())
        binding.autoStart.isChecked = prefs.autoStart
        binding.logText.movementMethod = ScrollingMovementMethod()

        binding.saveButton.setOnClickListener {
            if (save()) log("Settings saved")
        }
        binding.startButton.setOnClickListener {
            if (save()) startGateway()
        }
        binding.stopButton.setOnClickListener { stopGateway() }

        ensurePermissions()
        refreshStatus()
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun save(): Boolean {
        val url = binding.serverUrl.text?.toString()?.trim().orEmpty()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            log("Server URL must start with http:// or https://")
            return false
        }
        prefs.serverUrl = url
        prefs.token = binding.token.text?.toString()?.trim().orEmpty()
        prefs.pollSeconds = binding.pollSeconds.text?.toString()?.toIntOrNull()?.coerceIn(2, 300) ?: 5
        prefs.autoStart = binding.autoStart.isChecked
        if (!prefs.isConfigured()) {
            log("Gateway token is missing")
            return false
        }
        return true
    }

    private fun startGateway() {
        if (!prefs.isConfigured()) {
            log("Set the server URL and gateway token first")
            return
        }
        if (!hasSmsPermissions()) {
            ensurePermissions()
            log("Grant the SMS permissions first")
            return
        }
        ContextCompat.startForegroundService(this, Intent(this, GatewayService::class.java))
        log("Gateway started")
        refreshStatus()
    }

    private fun stopGateway() {
        stopService(Intent(this, GatewayService::class.java))
        log("Gateway stopped")
        refreshStatus()
    }

    private fun ensurePermissions() {
        val wanted = mutableListOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_PHONE_STATE,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            wanted += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) permissionLauncher.launch(missing.toTypedArray())
    }

    private fun hasSmsPermissions(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    private fun refreshStatus() {
        val service = when {
            GatewayService.running -> "running"
            else -> "stopped"
        }
        val permissions = if (hasSmsPermissions()) "granted" else "missing"
        binding.statusText.text = getString(R.string.status_line, service, permissions)
        binding.startButton.isEnabled = true
    }

    private fun log(message: String) {
        val timestamp = android.text.format.DateFormat.format("HH:mm:ss", System.currentTimeMillis())
        binding.logText.append("$timestamp  $message\n")
    }
}
