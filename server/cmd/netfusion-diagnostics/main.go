package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"netfusion/server/internal/network"
)

func main() {
	fmt.Println("NetFusion v0.1 Diagnostics")
	fmt.Println("==========================")

	discoverer := network.NewDiscoverer()
	ifaces, err := discoverer.Scan()
	if err != nil {
		fmt.Fprintf(os.Stderr, "interface scan failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Detected %d local interfaces:\n", len(ifaces))
	for _, iface := range ifaces {
		fmt.Printf(" - %-14s %-12s %s (up=%v)\n", iface.SystemName, iface.Kind, iface.IPAddress, iface.IsUp)
	}

	start := time.Now()
	conn, err := net.DialTimeout("tcp", "1.1.1.1:443", 2*time.Second)
	if err != nil {
		fmt.Printf("TCP probe 1.1.1.1:443: unreachable (%v)\n", err)
		return
	}
	_ = conn.Close()
	fmt.Printf("TCP probe 1.1.1.1:443: %.2f ms\n", float64(time.Since(start).Microseconds())/1000.0)
}
