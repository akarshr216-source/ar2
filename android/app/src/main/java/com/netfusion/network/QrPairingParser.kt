package com.netfusion.network

import com.netfusion.data.ParsedQrPairing
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

data class ValidatedServerUrl(
    val serverUrl: String,
    val isTrustedLocalNetwork: Boolean,
)

object QrPairingParser {
    fun parseAndValidate(rawQr: String): Result<ParsedQrPairing> {
        val trimmed = rawQr.trim()
        if (trimmed.isEmpty() || trimmed.length > 1024) {
            return Result.failure(IllegalArgumentException("Invalid QR code length."))
        }

        val uri = runCatching { URI(trimmed) }.getOrNull()
            ?: return Result.failure(IllegalArgumentException("Unrecognized QR code format."))

        if (!uri.scheme.equals("netfusion", ignoreCase = true) ||
            !uri.host.equals("pair", ignoreCase = true)
        ) {
            return Result.failure(IllegalArgumentException("This QR code is not a NetFusion pairing code."))
        }

        val params = parseQueryParams(uri.rawQuery)
        if (!params["token"].isNullOrBlank() || !params["auth_token"].isNullOrBlank()) {
            return Result.failure(IllegalArgumentException("Rejected unsafe QR payload."))
        }

        val rawServer = params["server"]?.trim()?.trimEnd('/')
            ?: return Result.failure(IllegalArgumentException("QR code is missing the server address."))
        val pairingId = params["pairing_id"]?.trim()
            ?: return Result.failure(IllegalArgumentException("QR code is missing the pairing ID."))
        val secret = params["secret"]?.trim()
            ?: return Result.failure(IllegalArgumentException("QR code is missing the temporary pairing secret."))

        if (!pairingId.matches(Regex("^pc-[a-fA-F0-9]{6,32}$"))) {
            return Result.failure(IllegalArgumentException("Invalid pairing ID format in QR code."))
        }
        val cleanSecret = secret.uppercase().replace(Regex("[^A-Z0-9]"), "")
        if (cleanSecret.length < 6) {
            return Result.failure(IllegalArgumentException("Invalid temporary pairing secret in QR code."))
        }

        val validatedServer = validateServerUrl(rawServer, addHttpIfMissing = false)
            .getOrElse { return Result.failure(it) }

        return Result.success(
            ParsedQrPairing(
                serverUrl = validatedServer.serverUrl,
                pairingId = pairingId,
                secret = secret,
                isTrustedLocalNetwork = validatedServer.isTrustedLocalNetwork,
            ),
        )
    }

    fun validateServerUrl(
        rawInput: String,
        addHttpIfMissing: Boolean = false,
    ): Result<ValidatedServerUrl> {
        var candidate = rawInput.trim().trimEnd('/')
        if (candidate.isEmpty()) {
            return Result.failure(
                IllegalArgumentException("Invalid server address. Enter your PC's Wi-Fi IPv4 URL (for example http://192.168.1.16:8080)."),
            )
        }
        if (addHttpIfMissing && !candidate.contains("://")) {
            candidate = "http://$candidate"
        }

        val serverUri = runCatching { URI(candidate) }.getOrNull()
            ?: return Result.failure(IllegalArgumentException("Invalid server address format."))
        val scheme = serverUri.scheme?.lowercase()
        val host = serverUri.host?.trim()?.removePrefix("[")?.removeSuffix("]")

        if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) {
            return Result.failure(IllegalArgumentException("Invalid server address. Must start with http:// or https://."))
        }

        if (isLoopbackOrUnreachableHost(host)) {
            return Result.failure(
                IllegalArgumentException(
                    "Invalid server address ($host cannot be reached from your phone). Use your Windows PC's Wi-Fi IPv4 address (for example http://192.168.1.16:8080).",
                ),
            )
        }

        val isLocal = isTrustedLocalLanHost(host)
        if (scheme == "http" && !isLocal) {
            return Result.failure(
                IllegalArgumentException("Servers outside your local Wi-Fi network must use HTTPS."),
            )
        }

        val portPart = if (serverUri.port != -1) ":${serverUri.port}" else ""
        val normalizedHost = if (host.contains(":")) "[$host]" else host
        val normalizedOrigin = "$scheme://$normalizedHost$portPart"
        return Result.success(
            ValidatedServerUrl(
                serverUrl = normalizedOrigin,
                isTrustedLocalNetwork = isLocal,
            ),
        )
    }

    fun isLoopbackOrUnreachableHost(host: String): Boolean {
        val lower = host.trim().lowercase().removePrefix("[").removeSuffix("]")
        if (lower.isEmpty() || lower == "localhost" || lower == "0.0.0.0" || lower == "::1" || lower == "::") {
            return true
        }
        return lower.startsWith("127.")
    }

    fun isTrustedLocalLanHost(host: String): Boolean {
        if (isLoopbackOrUnreachableHost(host)) {
            return false
        }
        val lower = host.lowercase()
        if (lower.endsWith(".local")) {
            return true
        }
        val parts = lower.split(".")
        if (parts.size == 4) {
            val octets = parts.mapNotNull { it.toIntOrNull() }
            if (octets.size == 4 && octets.all { it in 0..255 }) {
                val a = octets[0]
                val b = octets[1]
                if (a == 10) return true
                if (a == 192 && b == 168) return true
                if (a == 169 && b == 254) return true
                if (a == 172 && b in 16..31) return true
                return false
            }
        }
        return runCatching {
            val addr = InetAddress.getByName(host)
            !addr.isLoopbackAddress && (addr.isSiteLocalAddress || addr.isLinkLocalAddress)
        }.getOrDefault(false)
    }

    private fun parseQueryParams(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = linkedMapOf<String, String>()
        for (pair in rawQuery.split("&")) {
            if (pair.isEmpty()) continue
            val idx = pair.indexOf('=')
            val key = if (idx >= 0) pair.substring(0, idx) else pair
            val value = if (idx >= 0) pair.substring(idx + 1) else ""
            val decodedKey = URLDecoder.decode(key, StandardCharsets.UTF_8.name())
            val decodedValue = URLDecoder.decode(value, StandardCharsets.UTF_8.name())
            result[decodedKey] = decodedValue
        }
        return result
    }
}
