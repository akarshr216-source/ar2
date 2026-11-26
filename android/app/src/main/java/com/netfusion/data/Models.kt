package com.netfusion.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class PairRequest(
    @SerialName("pairing_id") val pairingId: String? = null,
    val secret: String,
    @SerialName("pairing_code") val pairingCode: String = secret,
    @SerialName("device_name") val deviceName: String,
    val platform: String = "android",
    @SerialName("device_model") val deviceModel: String,
    @SerialName("ip_address") val ipAddress: String,
    @SerialName("app_version") val appVersion: String,
)

@Serializable
data class RegisteredDevice(
    val id: String,
    val name: String,
    val platform: String,
    @SerialName("device_model") val deviceModel: String,
    @SerialName("ip_address") val ipAddress: String,
    @SerialName("pairing_status") val pairingStatus: String,
    @SerialName("connection_status") val connectionStatus: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("rx_bytes") val rxBytes: Long? = null,
    @SerialName("tx_bytes") val txBytes: Long? = null,
    @SerialName("download_bps") val downloadBps: Double? = null,
    @SerialName("upload_bps") val uploadBps: Double? = null,
    @SerialName("last_seen_at") val lastSeenAt: String,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class PairResponse(
    val device: RegisteredDevice,
    @SerialName("auth_token") val authToken: String,
    @SerialName("heartbeat_interval_seconds") val heartbeatIntervalSeconds: Int = 5,
)

@Serializable
data class HeartbeatRequest(
    @SerialName("ip_address") val ipAddress: String,
    @SerialName("app_version") val appVersion: String,
    @SerialName("device_model") val deviceModel: String,
    @SerialName("rx_bytes") val rxBytes: Long? = null,
    @SerialName("tx_bytes") val txBytes: Long? = null,
    @SerialName("download_bps") val downloadBps: Double? = null,
    @SerialName("upload_bps") val uploadBps: Double? = null,
)

@Serializable
data class HeartbeatResponse(
    val status: String,
    val device: RegisteredDevice,
)

@Serializable
data class ApiErrorResponse(
    val error: String? = null,
    val reason: String? = null,
)

data class ParsedQrPairing(
    val serverUrl: String,
    val pairingId: String,
    val secret: String,
    val isTrustedLocalNetwork: Boolean,
)

enum class ClientConnectionState {
    UNPAIRED,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
}
