package network

import (
	"net"
	"strings"
)

type DiscoveredInterface struct {
	SystemName string `json:"system_name"`
	Kind       string `json:"kind"`
	IPAddress  string `json:"ip_address"`
	MACAddress string `json:"mac_address"`
	IsUp       bool   `json:"is_up"`
}

type Discoverer struct{}

func NewDiscoverer() *Discoverer {
	return &Discoverer{}
}

func (d *Discoverer) Scan() ([]DiscoveredInterface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}

	var results []DiscoveredInterface
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		var ip string
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok && ipNet.IP.To4() != nil {
				ip = ipNet.IP.String()
				break
			}
		}
		if ip == "" {
			continue
		}

		results = append(results, DiscoveredInterface{
			SystemName: iface.Name,
			Kind:       classifyKind(iface.Name, iface.Flags),
			IPAddress:  ip,
			MACAddress: iface.HardwareAddr.String(),
			IsUp:       iface.Flags&net.FlagUp != 0,
		})
	}
	return results, nil
}

func classifyKind(name string, flags net.Flags) string {
	lower := strings.ToLower(name)
	switch {
	case flags&net.FlagLoopback != 0:
		return "loopback"
	case strings.Contains(lower, "wi-fi") || strings.Contains(lower, "wlan"):
		return "wifi"
	case strings.Contains(lower, "usb") || strings.Contains(lower, "rndis") || strings.Contains(lower, "wwan"):
		return "cellular_usb"
	default:
		return "ethernet"
	}
}
