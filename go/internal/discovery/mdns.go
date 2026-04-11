package discovery

import (
	"bytes"
	"encoding/binary"
	"log"
	"net"
	"time"
)

// GetLocalIP returns the primary LAN IPv4 address of this machine
func GetLocalIP() string {
	intfs, err := net.Interfaces()
	if err != nil {
		return "unknown"
	}
	for _, intf := range intfs {
		if intf.Flags&net.FlagUp == 0 || intf.Flags&net.FlagLoopback == 0 {
			continue
		}
		addrs, err := intf.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip != nil && !ip.IsLoopback() {
				return ip.String()
			}
		}
	}
	return "unknown"
}

// Start broadcasts sharetool presence via mDNS (UDP port 5353)
func Start(port int) error {
	addr, err := net.ResolveUDPAddr("udp4", "255.255.255.255:5353")
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: 5353})
	if err != nil {
		return err
	}
	defer conn.Close()

	conn.SetWriteBuffer(1024)

	msg := buildMdnsQuery(port)
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	_, err = conn.WriteToUDP(msg, addr)
	if err != nil {
		return err
	}
	log.Printf("[mDNS] Announced sharetool on port %d", port)
	return nil
}

// buildMdnsQuery builds a minimal mDNS service browsing query
func buildMdnsQuery(port int) []byte {
	var buf bytes.Buffer
	binary.Write(&buf, binary.BigEndian, uint16(0))     // Transaction ID
	binary.Write(&buf, binary.BigEndian, uint16(0x8000)) // Flags: query, recursion desired
	binary.Write(&buf, binary.BigEndian, uint16(1))      // QDCOUNT: 1 question
	binary.Write(&buf, binary.BigEndian, uint16(0))     // ANCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0))     // NSCOUNT
	binary.Write(&buf, binary.BigEndian, uint16(0))     // ARCOUNT

	// Question: _sharetool._tcp.local. PTR
	labels := []string{"_sharetool", "_tcp", "local"}
	for _, label := range labels {
		buf.WriteByte(byte(len(label)))
		buf.WriteString(label)
	}
	buf.WriteByte(0) // end of name
	binary.Write(&buf, binary.BigEndian, uint16(12))  // QTYPE: PTR
	binary.Write(&buf, binary.BigEndian, uint16(1))   // QCLASS: IN

	log.Printf("[mDNS] Broadcasting: sharetool._tcp.local:%d", port)
	return buf.Bytes()
}
