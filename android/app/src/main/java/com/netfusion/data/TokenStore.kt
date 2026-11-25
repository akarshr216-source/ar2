package com.netfusion.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(context: Context) {
    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            context,
            "netfusion_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()
        }

    var authToken: String?
        get() = prefs.getString(KEY_AUTH_TOKEN, null)
        set(value) {
            if (value == null) {
                prefs.edit().remove(KEY_AUTH_TOKEN).apply()
            } else {
                prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()
            }
        }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) {
            prefs.edit().putString(KEY_DEVICE_ID, value).apply()
        }

    var deviceName: String?
        get() = prefs.getString(KEY_DEVICE_NAME, null)
        set(value) {
            prefs.edit().putString(KEY_DEVICE_NAME, value).apply()
        }

    var heartbeatIntervalSeconds: Int
        get() = prefs.getInt(KEY_HEARTBEAT_SEC, 5)
        set(value) {
            prefs.edit().putInt(KEY_HEARTBEAT_SEC, value.coerceIn(3, 60)).apply()
        }

    fun clearPairing() {
        prefs.edit()
            .remove(KEY_AUTH_TOKEN)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_DEVICE_NAME)
            .apply()
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_HEARTBEAT_SEC = "heartbeat_sec"
    }
}
