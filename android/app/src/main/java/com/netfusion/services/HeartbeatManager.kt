package com.netfusion.services

import com.netfusion.data.ClientConnectionState
import com.netfusion.data.HeartbeatRequest
import com.netfusion.data.TokenStore
import com.netfusion.network.DeviceInfoProvider
import com.netfusion.network.NetFusionApiClient
import com.netfusion.network.TrafficCounterSample
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class DeviceTrafficSnapshot(
    val downloadBps: Double?,
    val uploadBps: Double?,
    val rxBytes: Long?,
    val txBytes: Long?,
)

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

    private val _traffic = MutableStateFlow<DeviceTrafficSnapshot?>(null)
    val traffic: StateFlow<DeviceTrafficSnapshot?> = _traffic

    private var loopJob: Job? = null
    private var previousSample: TrafficCounterSample? = null

    fun start() {
        if (loopJob?.isActive == true) return
        val token = tokenStore.authToken ?: run {
            _state.value = ClientConnectionState.UNPAIRED
            return
        }
        val url = tokenStore.serverUrl
        if (url.isBlank()) {
            _state.value = ClientConnectionState.DISCONNECTED
            _lastError.value = "Server address is missing."
            return
        }

        _state.value = ClientConnectionState.CONNECTING
        previousSample = deviceInfo.readTrafficCounters()

        loopJob = scope.launch {
            var retryDelayMs = 2000L
            while (isActive) {
                if (!deviceInfo.isLocalNetworkConnected()) {
                    _state.value = ClientConnectionState.DISCONNECTED
                    _lastError.value = "Waiting for local Wi-Fi connection"
                    delay(3000L)
                    continue
                }

                val currentSample = deviceInfo.readTrafficCounters()
                val prev = previousSample
                var downloadBps: Double? = null
                var uploadBps: Double? = null

                if (currentSample != null && prev != null) {
                    val elapsedSec = (currentSample.timestampMs - prev.timestampMs) / 1000.0
                    if (elapsedSec > 0.25) {
                        val rxDelta = (currentSample.rxBytes - prev.rxBytes).coerceAtLeast(0L)
                        val txDelta = (currentSample.txBytes - prev.txBytes).coerceAtLeast(0L)
                        downloadBps = (rxDelta * 8.0) / elapsedSec
                        uploadBps = (txDelta * 8.0) / elapsedSec
                    }
                }
                if (currentSample != null) {
                    previousSample = currentSample
                    _traffic.value = DeviceTrafficSnapshot(
                        downloadBps = downloadBps,
                        uploadBps = uploadBps,
                        rxBytes = currentSample.rxBytes,
                        txBytes = currentSample.txBytes,
                    )
                } else {
                    _traffic.value = null
                }

                val res = api.sendHeartbeat(
                    baseUrl = url,
                    authToken = token,
                    payload = HeartbeatRequest(
                        ipAddress = deviceInfo.getLocalWifiIpAddress(),
                        appVersion = deviceInfo.getAppVersion(),
                        deviceModel = deviceInfo.getDeviceModel(),
                        rxBytes = currentSample?.rxBytes,
                        txBytes = currentSample?.txBytes,
                        downloadBps = downloadBps,
                        uploadBps = uploadBps,
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
                        _traffic.value = null
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

    fun triggerImmediateReconnect() {
        stop()
        start()
    }

    fun stop() {
        loopJob?.cancel()
        loopJob = null
    }

    fun markUnpaired() {
        stop()
        tokenStore.clearPairing()
        previousSample = null
        _state.value = ClientConnectionState.UNPAIRED
        _traffic.value = null
        _lastHeartbeatAt.value = null
        _lastError.value = null
    }
}
