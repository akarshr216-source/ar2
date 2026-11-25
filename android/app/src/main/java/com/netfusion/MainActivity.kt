package com.netfusion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.lifecycle.lifecycleScope
import com.netfusion.data.TokenStore
import com.netfusion.network.DeviceInfoProvider
import com.netfusion.network.NetFusionApiClient
import com.netfusion.services.HeartbeatManager
import com.netfusion.ui.PairingScreen

class MainActivity : ComponentActivity() {
    private lateinit var heartbeatManager: HeartbeatManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val tokenStore = TokenStore(applicationContext)
        val deviceInfo = DeviceInfoProvider(applicationContext)
        val api = NetFusionApiClient()
        heartbeatManager = HeartbeatManager(lifecycleScope, tokenStore, deviceInfo, api)

        if (tokenStore.authToken != null) {
            heartbeatManager.start()
        }

        setContent {
            MaterialTheme {
                Surface {
                    PairingScreen(
                        tokenStore = tokenStore,
                        deviceInfo = deviceInfo,
                        api = api,
                        heartbeatManager = heartbeatManager,
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        heartbeatManager.stop()
        super.onDestroy()
    }
}
