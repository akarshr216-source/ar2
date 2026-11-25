package com.netfusion.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.netfusion.data.ClientConnectionState
import com.netfusion.data.PairRequest
import com.netfusion.data.TokenStore
import com.netfusion.network.DeviceInfoProvider
import com.netfusion.network.NetFusionApiClient
import com.netfusion.services.HeartbeatManager
import kotlinx.coroutines.launch

@Composable
fun PairingScreen(
    tokenStore: TokenStore,
    deviceInfo: DeviceInfoProvider,
    api: NetFusionApiClient,
    heartbeatManager: HeartbeatManager,
) {
    val scope = rememberCoroutineScope()
    val connectionState by heartbeatManager.state.collectAsState()
    val lastError by heartbeatManager.lastError.collectAsState()
    val lastHeartbeat by heartbeatManager.lastHeartbeatAt.collectAsState()

    var serverUrl by remember { mutableStateOf(tokenStore.serverUrl.ifBlank { "http://192.168.1.10:8080" }) }
    var deviceName by remember { mutableStateOf(tokenStore.deviceName ?: deviceInfo.getDeviceModel()) }
    var pairingCode by remember { mutableStateOf("") }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(text = "NetFusion", style = MaterialTheme.typography.headlineSmall)
        Text(
            text = "Model: ${deviceInfo.getDeviceModel()} · Local IP: ${deviceInfo.getLocalWifiIpAddress()}",
            style = MaterialTheme.typography.bodySmall,
        )

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(text = "Connection Status: ${connectionState.name}", style = MaterialTheme.typography.titleMedium)
                if (lastHeartbeat != null) {
                    Text(text = "Last Heartbeat: $lastHeartbeat", style = MaterialTheme.typography.bodySmall)
                }
                if (lastError != null) {
                    Text(
                        text = lastError ?: "",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        if (connectionState == ClientConnectionState.UNPAIRED) {
            OutlinedTextField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                label = { Text("Windows Server URL (LAN)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("Device Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = pairingCode,
                onValueChange = { pairingCode = it.uppercase() },
                label = { Text("Temporary Pairing Code (e.g. NF-XXXX-XXXX)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            statusMessage?.let {
                Text(text = it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                enabled = !busy && pairingCode.isNotBlank() && serverUrl.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    busy = true
                    statusMessage = null
                    scope.launch {
                        val result = api.pairDevice(
                            baseUrl = serverUrl,
                            payload = PairRequest(
                                pairingCode = pairingCode.trim(),
                                deviceName = deviceName.trim(),
                                deviceModel = deviceInfo.getDeviceModel(),
                                ipAddress = deviceInfo.getLocalWifiIpAddress(),
                                appVersion = deviceInfo.getAppVersion(),
                            ),
                        )
                        result.onSuccess { resp ->
                            tokenStore.serverUrl = serverUrl
                            tokenStore.authToken = resp.authToken
                            tokenStore.deviceId = resp.device.id
                            tokenStore.deviceName = resp.device.name
                            tokenStore.heartbeatIntervalSeconds = resp.heartbeatIntervalSeconds
                            pairingCode = ""
                            heartbeatManager.start()
                        }.onFailure { err ->
                            statusMessage = err.message ?: "Pairing failed"
                        }
                        busy = false
                    }
                },
            ) {
                Text(if (busy) "Pairing..." else "Pair with Windows Server")
            }
        } else {
            Spacer(modifier = Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { heartbeatManager.start() }) {
                    Text("Reconnect Now")
                }
                OutlinedButton(onClick = { heartbeatManager.markUnpaired() }) {
                    Text("Unpair Device")
                }
            }
        }
    }
}
