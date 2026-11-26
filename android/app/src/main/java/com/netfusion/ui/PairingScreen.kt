package com.netfusion.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Hub
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.netfusion.data.ClientConnectionState
import com.netfusion.data.PairRequest
import com.netfusion.data.ParsedQrPairing
import com.netfusion.data.TokenStore
import com.netfusion.network.DeviceInfoProvider
import com.netfusion.network.NetFusionApiClient
import com.netfusion.network.QrPairingParser
import com.netfusion.services.HeartbeatManager
import kotlinx.coroutines.launch
import java.util.Locale

private fun formatRateBps(bps: Double?): String {
    if (bps == null || !bps.isFinite()) return "Unavailable"
    val mbps = bps / 1_000_000.0
    return if (mbps >= 1.0) {
        String.format(Locale.US, "%.2f Mbps", mbps)
    } else {
        String.format(Locale.US, "%.0f Kbps", bps / 1_000.0)
    }
}

@Composable
fun PairingScreen(
    tokenStore: TokenStore,
    deviceInfo: DeviceInfoProvider,
    api: NetFusionApiClient,
    heartbeatManager: HeartbeatManager,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val scrollState = rememberScrollState()

    val connectionState by heartbeatManager.state.collectAsState()
    val lastError by heartbeatManager.lastError.collectAsState()
    val lastHeartbeat by heartbeatManager.lastHeartbeatAt.collectAsState()
    val traffic by heartbeatManager.traffic.collectAsState()

    var serverUrl by remember {
        mutableStateOf(tokenStore.serverUrl.ifBlank { "http://192.168.1.16:8080" })
    }
    var deviceName by remember { mutableStateOf(tokenStore.deviceName ?: deviceInfo.getDeviceModel()) }
    var manualPairingId by remember { mutableStateOf("") }
    var manualSecret by remember { mutableStateOf("") }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var pairedNotice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var scanningQr by remember { mutableStateOf(false) }
    var showManualFallback by remember { mutableStateOf(false) }
    var pendingQrConfirmation by remember { mutableStateOf<ParsedQrPairing?>(null) }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            statusMessage = null
            scanningQr = true
        } else {
            scanningQr = false
            showManualFallback = true
            statusMessage = "Camera permission is required to scan the QR code. You can also enter the pairing details manually below."
        }
    }

    fun startQrScan() {
        val hasCameraPermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        if (hasCameraPermission) {
            statusMessage = null
            scanningQr = true
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    fun executePairing(
        targetServerUrl: String,
        pairingId: String?,
        secret: String,
    ) {
        val validated = QrPairingParser.validateServerUrl(targetServerUrl, addHttpIfMissing = true)
            .getOrElse { err ->
                pendingQrConfirmation = null
                statusMessage = err.message ?: "Invalid server address."
                return
            }

        busy = true
        statusMessage = null
        pairedNotice = null
        scope.launch {
            val result = api.pairDevice(
                baseUrl = validated.serverUrl,
                payload = PairRequest(
                    pairingId = pairingId?.takeIf { it.isNotBlank() },
                    secret = secret.trim(),
                    pairingCode = secret.trim(),
                    deviceName = deviceName.trim().ifEmpty { deviceInfo.getDeviceModel() },
                    deviceModel = deviceInfo.getDeviceModel(),
                    ipAddress = deviceInfo.getLocalWifiIpAddress(),
                    appVersion = deviceInfo.getAppVersion(),
                ),
            )
            result.onSuccess { resp ->
                tokenStore.serverUrl = validated.serverUrl
                tokenStore.authToken = resp.authToken
                tokenStore.deviceId = resp.device.id
                tokenStore.deviceName = resp.device.name
                tokenStore.heartbeatIntervalSeconds = resp.heartbeatIntervalSeconds
                serverUrl = validated.serverUrl
                manualPairingId = ""
                manualSecret = ""
                pendingQrConfirmation = null
                pairedNotice = "Device successfully paired. Sending initial heartbeat..."
                heartbeatManager.start()
            }.onFailure { err ->
                pendingQrConfirmation = null
                pairedNotice = null
                statusMessage = err.message ?: "Unable to connect to the NetFusion server."
            }
            busy = false
        }
    }

    pendingQrConfirmation?.let { parsed ->
        AlertDialog(
            onDismissRequest = { if (!busy) pendingQrConfirmation = null },
            title = { Text("Confirm NetFusion Server") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Pair this phone with the NetFusion server below?",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(
                            modifier = Modifier.padding(12.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(
                                text = parsed.serverUrl,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = if (parsed.isTrustedLocalNetwork) {
                                    "Detected on your local Wi-Fi network"
                                } else {
                                    "Remote HTTPS server"
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Text(
                        text = "Only confirm if you recognize this computer and Wi-Fi network.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = !busy,
                    onClick = {
                        executePairing(
                            targetServerUrl = parsed.serverUrl,
                            pairingId = parsed.pairingId,
                            secret = parsed.secret,
                        )
                    },
                ) {
                    Text(if (busy) "Connecting..." else "Connect")
                }
            },
            dismissButton = {
                TextButton(
                    enabled = !busy,
                    onClick = { pendingQrConfirmation = null },
                ) {
                    Text("Cancel")
                }
            },
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Brand Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    imageVector = Icons.Default.Hub,
                    contentDescription = "NetFusion logo",
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(11.dp),
                )
            }
            Column {
                Text(
                    text = "NetFusion",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    text = "${deviceInfo.getDeviceModel()} · Wi-Fi IP: ${deviceInfo.getLocalWifiIpAddress()}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Clear Connection Status Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val statusLabel = when (connectionState) {
                    ClientConnectionState.UNPAIRED -> "Not paired"
                    ClientConnectionState.CONNECTING -> "Device paired — connecting..."
                    ClientConnectionState.CONNECTED -> "Connected"
                    ClientConnectionState.DISCONNECTED -> "Disconnected"
                }
                Text(
                    text = "Status: $statusLabel",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (connectionState == ClientConnectionState.CONNECTING && pairedNotice != null) {
                    Text(
                        text = pairedNotice ?: "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                if (tokenStore.serverUrl.isNotBlank() && connectionState != ClientConnectionState.UNPAIRED) {
                    Text(
                        text = "Server: ${tokenStore.serverUrl}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (connectionState == ClientConnectionState.CONNECTED) {
                    Text(
                        text = "Traffic: ${formatRateBps(traffic?.downloadBps)} ↓ · ${formatRateBps(traffic?.uploadBps)} ↑",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (lastHeartbeat != null) {
                    Text(
                        text = "Last Heartbeat: $lastHeartbeat",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
                value = deviceName,
                onValueChange = { deviceName = it },
                label = { Text("Device Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            if (scanningQr) {
                QrScannerView(
                    onQrScanned = { rawQr ->
                        scanningQr = false
                        QrPairingParser.parseAndValidate(rawQr)
                            .onSuccess { parsed ->
                                statusMessage = null
                                pendingQrConfirmation = parsed
                            }
                            .onFailure { err ->
                                statusMessage = err.message ?: "Invalid NetFusion QR code."
                            }
                    },
                    onCancel = { scanningQr = false },
                )
            } else {
                Button(
                    enabled = !busy,
                    onClick = { startQrScan() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Icon(
                        imageVector = Icons.Default.QrCodeScanner,
                        contentDescription = null,
                        modifier = Modifier.size(22.dp),
                    )
                    Spacer(modifier = Modifier.width(10.dp))
                    Text(
                        text = "Scan QR Code",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }

            statusMessage?.let { msg ->
                Text(
                    text = msg,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
            ) {
                TextButton(onClick = { showManualFallback = !showManualFallback }) {
                    Text(
                        if (showManualFallback) "Hide Manual Connection" else "Connect Manually Without QR Code",
                    )
                }
            }

            if (showManualFallback) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            text = "Manual Pairing",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it },
                            label = { Text("PC Server Address (e.g. http://192.168.1.16:8080)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = manualSecret,
                            onValueChange = { manualSecret = it.uppercase() },
                            label = { Text("Temporary Pairing Code (NF-XXXX-XXXX-XXXX)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = manualPairingId,
                            onValueChange = { manualPairingId = it.trim() },
                            label = { Text("Pairing ID (optional)") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedButton(
                            enabled = !busy && serverUrl.isNotBlank() && manualSecret.isNotBlank(),
                            modifier = Modifier.fillMaxWidth(),
                            onClick = {
                                executePairing(
                                    targetServerUrl = serverUrl,
                                    pairingId = manualPairingId.trim().ifBlank { null },
                                    secret = manualSecret.trim(),
                                )
                            },
                        ) {
                            Text(if (busy) "Connecting..." else "Connect Manually")
                        }
                    }
                }
            }
        } else {
            Spacer(modifier = Modifier.height(4.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = { heartbeatManager.triggerImmediateReconnect() },
                ) {
                    Text("Reconnect Now")
                }
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    onClick = { heartbeatManager.markUnpaired() },
                ) {
                    Text("Unpair Device")
                }
            }
        }
    }
}
