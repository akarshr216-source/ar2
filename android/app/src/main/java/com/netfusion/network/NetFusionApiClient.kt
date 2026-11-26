package com.netfusion.network

import com.netfusion.data.ApiErrorResponse
import com.netfusion.data.HeartbeatRequest
import com.netfusion.data.HeartbeatResponse
import com.netfusion.data.PairRequest
import com.netfusion.data.PairResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

class PairingRejectedException(
    val httpCode: Int,
    val reason: String?,
    override val message: String,
) : Exception(message)

class NetFusionApiClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .build()

    private fun validateServerBaseUrl(baseUrl: String): String {
        return QrPairingParser.validateServerUrl(baseUrl, addHttpIfMissing = false)
            .getOrThrow()
            .serverUrl
    }

    private fun parseErrorMessage(raw: String, fallback: String): Pair<String?, String> {
        val parsed = runCatching { json.decodeFromString(ApiErrorResponse.serializer(), raw) }.getOrNull()
        val msg = parsed?.error?.takeIf { it.isNotBlank() } ?: fallback
        return parsed?.reason to msg
    }

    private fun mapNetworkException(err: Throwable): Throwable {
        return when (err) {
            is PairingRejectedException,
            is IllegalArgumentException,
            is SecurityException -> err
            is SocketTimeoutException ->
                IOException("Connection timed out while contacting the NetFusion server.", err)
            is ConnectException ->
                IOException("Server is offline or refused the connection. Ensure the Windows Go API server and firewall allow port 8080.", err)
            is UnknownHostException ->
                IOException("Server cannot be reached. Check the server address and Wi-Fi connection.", err)
            is SSLException ->
                IOException("Secure HTTPS handshake failed with the server.", err)
            is IOException ->
                IOException("Server cannot be reached over the current network.", err)
            else -> err
        }
    }

    suspend fun checkHealth(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val clean = validateServerBaseUrl(baseUrl)
            val req = Request.Builder().url("$clean/api/health").get().build()
            http.newCall(req).execute().use { resp -> resp.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun pairDevice(baseUrl: String, payload: PairRequest): Result<PairResponse> =
        withContext(Dispatchers.IO) {
            runCatching {
                val clean = validateServerBaseUrl(baseUrl)
                val body = json.encodeToString(PairRequest.serializer(), payload)
                    .toRequestBody(jsonMedia)
                val req = Request.Builder()
                    .url("$clean/api/clients/pair")
                    .post(body)
                    .build()

                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        val (reason, parsedMsg) = parseErrorMessage(raw, "Pairing failed (${resp.code})")
                        val friendly = when {
                            resp.code == 429 -> parsedMsg
                            reason == "expired" -> "Pairing code expired. Generate a new QR code on your PC."
                            reason == "used" -> "Pairing code already used. Generate a new QR code on your PC."
                            resp.code == 401 -> "Authentication failed. $parsedMsg"
                            resp.code >= 500 -> "NetFusion server error (${resp.code}). Please try again."
                            else -> parsedMsg
                        }
                        throw PairingRejectedException(resp.code, reason, friendly)
                    }
                    json.decodeFromString(PairResponse.serializer(), raw)
                }
            }.recoverCatching { err ->
                throw mapNetworkException(err)
            }
        }

    suspend fun sendHeartbeat(
        baseUrl: String,
        authToken: String,
        payload: HeartbeatRequest,
    ): Result<HeartbeatResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val clean = validateServerBaseUrl(baseUrl)
            val body = json.encodeToString(HeartbeatRequest.serializer(), payload)
                .toRequestBody(jsonMedia)
            val req = Request.Builder()
                .url("$clean/api/clients/heartbeat")
                .addHeader("Authorization", "Bearer $authToken")
                .post(body)
                .build()

            http.newCall(req).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (resp.code == 401) {
                    throw SecurityException("Authentication failed. Device token was rejected or revoked.")
                }
                if (!resp.isSuccessful) {
                    val (_, msg) = parseErrorMessage(raw, "Heartbeat failed (${resp.code})")
                    error(msg)
                }
                json.decodeFromString(HeartbeatResponse.serializer(), raw)
            }
        }.recoverCatching { err ->
            throw mapNetworkException(err)
        }
    }
}
