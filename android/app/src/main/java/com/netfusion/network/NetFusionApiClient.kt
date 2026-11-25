package com.netfusion.network

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
import java.util.concurrent.TimeUnit

class NetFusionApiClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build()

    suspend fun checkHealth(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        val clean = baseUrl.trim().trimEnd('/')
        val req = Request.Builder().url("$clean/api/health").get().build()
        http.newCall(req).execute().use { resp -> resp.isSuccessful }
    }

    suspend fun pairDevice(baseUrl: String, payload: PairRequest): Result<PairResponse> =
        withContext(Dispatchers.IO) {
            runCatching {
                val clean = baseUrl.trim().trimEnd('/')
                val body = json.encodeToString(PairRequest.serializer(), payload)
                    .toRequestBody(jsonMedia)
                val req = Request.Builder()
                    .url("$clean/api/clients/pair")
                    .post(body)
                    .build()

                http.newCall(req).execute().use { resp ->
                    val raw = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        error("Pairing rejected (${resp.code}): $raw")
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
            val clean = baseUrl.trim().trimEnd('/')
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
                    throw SecurityException("Device token unauthorized or revoked")
                }
                if (!resp.isSuccessful) {
                    error("Heartbeat failed (${resp.code}): $raw")
                }
                json.decodeFromString(HeartbeatResponse.serializer(), raw)
            }
        }
    }
}
