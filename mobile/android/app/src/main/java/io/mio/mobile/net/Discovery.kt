package io.mio.mobile.net

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.net.InetAddress

/**
 * mDNS service discovery for `_mio._tcp.local.` (the type the desktop
 * announces in `desktop/src/server/transport/mdns.ts`).
 *
 * Phase M-1 only consumes discovery for *display* purposes — the
 * pairing QR carries an explicit host:port already, so reachability
 * doesn't depend on mDNS. We use it to:
 *
 * 1. **Show "Mio is on this LAN"** in the pairing screen ("Found
 *    `Mio on DESKTOP-NAME`") so a user who's about to scan a QR
 *    can sanity-check they're on the right Wi-Fi.
 * 2. **Heal stale IPs:** if a paired desktop's IP shifts after a
 *    DHCP lease change, M-2 will use the discovered host to reroute
 *    automatically. M-1 just emits the events.
 */
class Discovery private constructor(private val nsdManager: NsdManager) {

    data class Service(
        val name: String,
        val host: InetAddress?,
        val port: Int,
        val deviceName: String?,
    )

    /**
     * Cold flow that starts a discovery session on collection and tears
     * it down on cancellation. Each found service is resolved to its
     * IP/port before being emitted — unresolved services are dropped
     * (we'd just have to query them ourselves, which is what `resolve`
     * is for).
     */
    fun services(): Flow<Service> = callbackFlow {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.d(TAG, "discovery started for $serviceType")
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                Log.d(TAG, "found ${info.serviceName} (${info.serviceType})")
                resolve(info) { resolved ->
                    val host = resolved.hostInetAddress() ?: return@resolve
                    val deviceName = resolved.attributes["deviceName"]?.toString(Charsets.UTF_8)
                    trySend(
                        Service(
                            name = resolved.serviceName ?: "Mio",
                            host = host,
                            port = resolved.port,
                            deviceName = deviceName,
                        ),
                    )
                }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                Log.d(TAG, "lost ${info.serviceName}")
            }

            override fun onDiscoveryStopped(serviceType: String) {
                Log.d(TAG, "discovery stopped for $serviceType")
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "start discovery failed errorCode=$errorCode")
                close(IllegalStateException("NSD start failed: $errorCode"))
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "stop discovery failed errorCode=$errorCode")
            }
        }

        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose {
            runCatching { nsdManager.stopServiceDiscovery(listener) }
        }
    }

    private fun resolve(info: NsdServiceInfo, onResolved: (NsdServiceInfo) -> Unit) {
        val resolveListener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "resolve failed for ${info.serviceName}: $errorCode")
            }

            override fun onServiceResolved(resolved: NsdServiceInfo) {
                onResolved(resolved)
            }
        }
        nsdManager.resolveService(info, resolveListener)
    }

    companion object {
        private const val TAG = "MioDiscovery"
        private const val SERVICE_TYPE = "_mio._tcp."

        fun from(context: Context): Discovery {
            val mgr = context.getSystemService(Context.NSD_SERVICE) as NsdManager
            return Discovery(mgr)
        }
    }
}

private fun NsdServiceInfo.hostInetAddress(): InetAddress? {
    // API 34 deprecates the synchronous `host` getter in favour of a
    // callback API; on 34 we still get a value back, just with a
    // deprecation note. We accept the warning until min SDK can move.
    @Suppress("DEPRECATION")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        return host
    }
    @Suppress("DEPRECATION")
    return host
}
