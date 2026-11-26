package com.netfusion.network

import android.net.Uri
import com.netfusion.data.ParsedQrPairing
import java.net.InetAddress

object QrPairingParser {
    fun parseAndValidate(rawQr: String): Result<ParsedQrPairing> {
        val trimmed = rawQr.trim()
        if (trimmed.isEmpty() || trimmed.length > 1024) {
            return Result.failure(IllegalArgumentException("Invalid QR code length."))
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull()
            ?: return Result.failure(IllegalArgumentException("Unrecognized QR code format."))

        if (!uri.scheme.equals("netfusion", ignoreCase = true) ||
            !uri.host.equals("pair", ignoreCase = true)
        ) {
            return Result.failure(IllegalArgumentException("This QR code is not a NetFusion pairing code."))
        }

        if (!uri.getQueryParameter("token").isNullOrBlank() ||
            !uri.getQueryParameter("auth_token").isNullOrBlank()
        ) {
            return Result.failure(IllegalArgumentException("Rejected unsafe QR payload."))
        }

        val rawServer = uri.getQueryParameter("server")?.trim()?.trimEnd('/')
            ?: return Result.failure(IllegalArgumentException("QR code is missing the server address."))
        val pairingId = uri.getQueryParameter("pairing_id")?.trim()
            ?: return Result.failure(IllegalArgumentException("QR code is missing the pairing ID."))
        val secret = uri.getQueryParameter("secret")?.trim()
            ?: return Result.failure(IllegalArgumentException("QR code is missing the temporary pairing secret."))

        if (!pairingId.matches(Regex("^pc-[a-fA-F0-9]{6,32}$"))) {
            return Result.failure(IllegalArgumentException("Invalid pairing ID format in QR code."))
        }
        val cleanSecret = secret.uppercase().replace(Regex("[^A-Z0-9]"), "")
        if (cleanSecret.length < 6) {
            return Result.failure(IllegalArgumentException("Invalid temporary pairing secret in QR code."))
        }

        val serverUri = runCatching { Uri.parse(rawServer) }.getOrNull()
            ?: return Result.failure(IllegalArgumentException("Invalid server URL in QR code."))
        val scheme = serverUri.scheme?.lowercase()
        val host = serverUri.host?.trim()
        if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) {
            return Result.failure(IllegalArgumentException("Server address must be a valid HTTP/HTTPS URL."))
        }

        val isLocal = isTrustedLocalHost(host)
        if (scheme == "http" && !isLocal) {
            return Result.failure(
                IllegalArgumentException("Connections outside your local Wi-Fi network must use HTTPS."),
            )
        }

        return Result.success(
            ParsedQrPairing(
                serverUrl = rawServer,
                pairingId = pairingId,
                secret = secret,
                isTrustedLocalNetwork = isLocal,
            ),
        )
    }

    fun isTrustedLocalHost(host: String): Boolean {
        val lower = host.lowercase()
        if (lower == "localhost" || lower == "127.0.0.1" || lower.endsWith(".local")) {
            return true
        }
        val parts = lower.split(".")
        if (parts.size == 4) {
            val octets = parts.mapNotNull { it.toIntOrNull() }
            if (octets.size == 4 && octets.all { it in 0..255 }) {
                val a = octets[0]
                val b = octets[1]
                if (a == 10 || a == 127) return true
                if (a == 192 && b == 168) return true
                if (a == 169 && b == 254) return true
                if (a == 172 && b in 16..31) return true
            }
        }
        return runCatching {
            val addr = InetAddress.getByName(host)
            addr.isLoopbackAddress || addr.isSiteLocalAddress || addr.isLinkLocalAddress
        }.getOrDefault(false)
    }
}
