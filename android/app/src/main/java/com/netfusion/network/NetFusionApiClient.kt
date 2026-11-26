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
import java.net.URI
import java.util.concurrent.TimeUnit

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
        .build()

    private fun validateServerBaseUrl(baseUrl: String): String {
        val clean = baseUrl.trim().trimEnd('/')
        val uri = runCatching { URI(clean) }.getOrNull()
            ?: throw IllegalArgumentException("Invalid server URL.")
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.trim()
        if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) {
            throw IllegalArgumentException("Server address must start with http:// or https://.")
        }
        if (scheme == "http" && !QrPairingParser.isTrustedLocalHost(host)) {
            throw IllegalArgumentException("Non-local NetFusion servers must use HTTPS.")
        }
        return clean
    }

    private fun parseErrorMessage(raw: String, fallback: String): Pair<String?, String> {
        val parsed = runCatching { json.decodeFromString(ApiErrorResponse.serializer(), raw) }.getOrNull()
        val msg = parsed?.error?.takeIf { it.isNotBlank() } ?: fallback
        return parsed?.reason to msg
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
                        val (reason, msg) = parseErrorMessage(raw, "Pairing failed (${resp.code})")
                        throw PairingRejectedException(resp.code, reason, msg)
                    }
                    json.decodeFromString(PairResponse.serializer(), raw)
                }
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
                    throw SecurityException("Device authentication token was rejected or revoked.")
                }
                if (!resp.isSuccessful) {
                    val (_, msg) = parseErrorMessage(raw, "Heartbeat failed (${resp.code})")
                    error(msg)
                }
                json.decodeFromString(HeartbeatResponse.serializer(), raw)
            }
        }
    }
}
