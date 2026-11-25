package com.netfusion.services

import com.netfusion.data.ClientConnectionState
import com.netfusion.data.HeartbeatRequest
import com.netfusion.data.TokenStore
import com.netfusion.network.DeviceInfoProvider
import com.netfusion.network.NetFusionApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class HeartbeatManager(
    private val scope: CoroutineScope,
    private val tokenStore: TokenStore,
    private val deviceInfo: DeviceInfoProvider,
    private val api: NetFusionApiClient,
) {
    private val _state = MutableStateFlow(
        if (tokenStore.authToken != null) ClientConnectionState.CONNECTING
        else ClientConnectionState.UNPAIRED,
    )
    val state: StateFlow<ClientConnectionState> = _state

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    private val _lastHeartbeatAt = MutableStateFlow<String?>(null)
    val lastHeartbeatAt: StateFlow<String?> = _lastHeartbeatAt

    private var loopJob: Job? = null

    fun start() {
        if (loopJob?.isActive == true) return
        val token = tokenStore.authToken ?: run {
            _state.value = ClientConnectionState.UNPAIRED
            return
        }
        val url = tokenStore.serverUrl
        if (url.isBlank()) {
            _state.value = ClientConnectionState.DISCONNECTED
            return
        }

        loopJob = scope.launch {
            var retryDelayMs = 2000L
            while (isActive) {
                if (!deviceInfo.isLocalNetworkConnected()) {
                    _state.value = ClientConnectionState.DISCONNECTED
                    _lastError.value = "Waiting for local Wi-Fi connection"
                    delay(3000L)
                    continue
                }

                val res = api.sendHeartbeat(
                    baseUrl = url,
                    authToken = token,
                    payload = HeartbeatRequest(
                        ipAddress = deviceInfo.getLocalWifiIpAddress(),
                        appVersion = deviceInfo.getAppVersion(),
                        deviceModel = deviceInfo.getDeviceModel(),
                    ),
                )

                res.onSuccess { ack ->
                    _state.value = ClientConnectionState.CONNECTED
                    _lastError.value = null
                    _lastHeartbeatAt.value = ack.device.lastSeenAt
                    retryDelayMs = 2000L
                    delay(tokenStore.heartbeatIntervalSeconds * 1000L)
                }.onFailure { err ->
                    if (err is SecurityException) {
                        tokenStore.clearPairing()
                        _state.value = ClientConnectionState.UNPAIRED
                        _lastError.value = "Device unpaired or token revoked on server."
                        loopJob?.cancel()
                        return@launch
                    }
                    _state.value = ClientConnectionState.DISCONNECTED
                    _lastError.value = err.message ?: "Unable to reach NetFusion server"
                    delay(retryDelayMs)
                    retryDelayMs = (retryDelayMs * 2).coerceAtMost(20000L)
                }
            }
        }
    }

    fun stop() {
        loopJob?.cancel()
        loopJob = null
    }

    fun markUnpaired() {
        stop()
        tokenStore.clearPairing()
        _state.value = ClientConnectionState.UNPAIRED
        _lastHeartbeatAt.value = null
        _lastError.value = null
    }
}
