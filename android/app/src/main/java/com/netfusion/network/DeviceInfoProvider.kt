package com.netfusion.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.TrafficStats
import android.os.Build
import com.netfusion.BuildConfig
import java.net.Inet4Address

data class TrafficCounterSample(
    val rxBytes: Long,
    val txBytes: Long,
    val timestampMs: Long,
)

class DeviceInfoProvider(private val context: Context) {

    fun getDeviceModel(): String {
        val manufacturer = Build.MANUFACTURER.trim()
        val model = Build.MODEL.trim()
        return if (model.startsWith(manufacturer, ignoreCase = true)) {
            model
        } else {
            "$manufacturer $model"
        }
    }

    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    fun readTrafficCounters(): TrafficCounterSample? {
        val rx = TrafficStats.getTotalRxBytes()
        val tx = TrafficStats.getTotalTxBytes()
        if (rx == TrafficStats.UNSUPPORTED.toLong() || tx == TrafficStats.UNSUPPORTED.toLong()) {
            return null
        }
        return TrafficCounterSample(
            rxBytes = rx,
            txBytes = tx,
            timestampMs = System.currentTimeMillis(),
        )
    }

    fun getLocalWifiIpAddress(): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val activeNetwork = cm.activeNetwork ?: return "0.0.0.0"
        val caps = cm.getNetworkCapabilities(activeNetwork) ?: return "0.0.0.0"
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        ) {
            return "0.0.0.0"
        }

        val linkProps = cm.getLinkProperties(activeNetwork) ?: return "0.0.0.0"
        for (linkAddr in linkProps.linkAddresses) {
            val addr = linkAddr.address
            if (addr is Inet4Address && !addr.isLoopbackAddress) {
                return addr.hostAddress ?: "0.0.0.0"
            }
        }
        return "0.0.0.0"
    }

    fun isLocalNetworkConnected(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }
}
