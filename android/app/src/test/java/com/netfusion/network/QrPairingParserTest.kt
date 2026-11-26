package com.netfusion.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QrPairingParserTest {
    @Test
    fun parsesValidLanQrPayloadWithoutSubstitutions() {
        val raw = "netfusion://pair?server=http%3A%2F%2F192.168.1.16%3A8080&pairing_id=pc-a1b2c3d4&secret=NF-AB12-CD34-EF56"
        val parsed = QrPairingParser.parseAndValidate(raw).getOrThrow()

        assertEquals("http://192.168.1.16:8080", parsed.serverUrl)
        assertEquals("pc-a1b2c3d4", parsed.pairingId)
        assertEquals("NF-AB12-CD34-EF56", parsed.secret)
        assertTrue(parsed.isTrustedLocalNetwork)
    }

    @Test
    fun rejectsLocalhostAndLoopbackInQrAndManualUrls() {
        val localhostQr = "netfusion://pair?server=http%3A%2F%2Flocalhost%3A3000&pairing_id=pc-a1b2c3d4&secret=NF-AB12-CD34-EF56"
        assertTrue(QrPairingParser.parseAndValidate(localhostQr).isFailure)

        val loopbackQr = "netfusion://pair?server=http%3A%2F%2F127.0.0.1%3A8080&pairing_id=pc-a1b2c3d4&secret=NF-AB12-CD34-EF56"
        assertTrue(QrPairingParser.parseAndValidate(loopbackQr).isFailure)

        assertTrue(QrPairingParser.validateServerUrl("http://localhost:8080").isFailure)
        assertTrue(QrPairingParser.validateServerUrl("http://127.0.0.1:8080").isFailure)
        assertTrue(QrPairingParser.validateServerUrl("http://0.0.0.0:8080").isFailure)
    }

    @Test
    fun rejectsUnsafeAuthTokensInQrAndEnforcesHttpsForPublicServers() {
        val tokenQr = "netfusion://pair?server=http%3A%2F%2F192.168.1.16%3A8080&pairing_id=pc-a1b2c3d4&secret=NF-AB12-CD34-EF56&auth_token=nf_dev_leak"
        assertTrue(QrPairingParser.parseAndValidate(tokenQr).isFailure)

        val publicHttp = QrPairingParser.validateServerUrl("http://203.0.113.10:8080")
        assertTrue(publicHttp.isFailure)

        val publicHttps = QrPairingParser.validateServerUrl("https://netfusion.example.com").getOrThrow()
        assertEquals("https://netfusion.example.com", publicHttps.serverUrl)
        assertFalse(publicHttps.isTrustedLocalNetwork)
    }

    @Test
    fun normalizesManualLanAddressWhenSchemeOmitted() {
        val validated = QrPairingParser.validateServerUrl("192.168.1.16:8080", addHttpIfMissing = true).getOrThrow()
        assertEquals("http://192.168.1.16:8080", validated.serverUrl)
        assertTrue(validated.isTrustedLocalNetwork)
    }
}
