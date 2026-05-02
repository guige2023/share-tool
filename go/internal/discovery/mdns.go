package discovery

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// Peer represents a discovered sharetool instance
type Peer struct {
	Name     string
	IP       string
	Port     int
	LastSeen time.Time
}

// PeerCallback is called when a new peer is discovered or goes away
type PeerCallback func(peer Peer)

// Discovery handles mDNS-based peer discovery
type Discovery struct {
	iface     *net.Interface
	conn      *net.UDPConn
	peers     map[string]Peer
	mu        sync.RWMutex
	callback  PeerCallback
	stopCh    chan struct{}
	localPort int
	localName string
}

// New creates a new Discovery instance for the given local port
func New(localPort int) (*Discovery, error) {
	iface, err := defaultInterface()
	if err != nil {
		return nil, fmt.Errorf("no suitable network interface: %v", err)
	}
	return &Discovery{
		iface:     iface,
		peers:     make(map[string]Peer),
		localPort: localPort,
		localName: hostname(),
		stopCh:    make(chan struct{}),
	}, nil
}

// Start begins mDNS discovery - both broadcasting and listening
func (d *Discovery) Start(callback PeerCallback) error {
	d.callback = callback

	// Bind to mDNS multicast address 224.0.0.251:5353
	addr := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	conn, err := net.ListenMulticastUDP("udp4", d.iface, addr)
	if err != nil {
		return fmt.Errorf("listen multicast UDP: %v", err)
	}
	d.conn = conn

	log.Printf("[mDNS] Listening on %s", d.iface.Name)

	// Start all background loops
	go d.broadcastLoop()    // periodic query
	go d.advertiseLoop()    // periodic self-advertisement
	go d.listenLoop()       // listen for responses

	return nil
}

// Stop shuts down discovery
func (d *Discovery) Stop() {
	close(d.stopCh)
	if d.conn != nil {
		d.conn.Close()
	}
}

// Peers returns current list of discovered peers
func (d *Discovery) Peers() []Peer {
	d.mu.RLock()
	defer d.mu.RUnlock()
	var peers []Peer
	for _, p := range d.peers {
		peers = append(peers, p)
	}
	return peers
}

func (d *Discovery) broadcastLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Send initial probe
	d.sendQuery()

	for {
		select {
		case <-ticker.C:
			d.sendQuery()
		case <-d.stopCh:
			return
		}
	}
}

func (d *Discovery) listenLoop() {
	buf := make([]byte, 65536)
	for {
		select {
		case <-d.stopCh:
			return
		default:
			d.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			n, src, err := d.conn.ReadFromUDP(buf)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				continue
			}
			d.handlePacket(buf[:n], src)
		}
	}
}

func (d *Discovery) sendQuery() {
	query := buildMdnsQuery("_sharetool._tcp.local.")

	addr := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	_, err := d.conn.WriteToUDP(query, addr)
	if err != nil {
		log.Printf("[mDNS] Query send failed: %v", err)
	}
}

// parseMdnsName parses a mDNS name from the packet starting at offset.
// Returns the decoded name and the new offset.
func parseMdnsName(buf []byte, offset int) (string, int, error) {
	var parts []string

	for {
		if offset >= len(buf) {
			return "", offset, fmt.Errorf("buffer overflow")
		}
		length := int(buf[offset])
		if length == 0 {
			offset++
			break
		}
		// Check for compression pointer (top 2 bits set)
		if length&0xC0 == 0xC0 {
			if offset+1 >= len(buf) {
				return "", offset, fmt.Errorf("compressed pointer overflow")
			}
			ptr := int(buf[offset]&0x3F)<<8 | int(buf[offset+1])
			// Recursively parse the pointed-to name
			pointed, _, err := parseMdnsName(buf, ptr)
			if err != nil {
				return "", offset, err
			}
			parts = append(parts, pointed)
			offset += 2
			break
		}
		if length > 63 {
			return "", offset, fmt.Errorf("label too long")
		}
		offset++
		if offset+length > len(buf) {
			return "", offset, fmt.Errorf("name extends past buffer")
		}
		parts = append(parts, string(buf[offset:offset+length]))
		offset += length
	}

	if len(parts) == 0 {
		return "", offset, nil
	}
	return strings.Join(parts, "."), offset, nil
}

func (d *Discovery) handlePacket(buf []byte, src *net.UDPAddr) {
	// Skip if too short (min mDNS header is 12 bytes)
	if len(buf) < 12 {
		return
	}

	// Parse mDNS header
	// Transaction ID (2), Flags (2), QDCOUNT (2), ANCOUNT (2), NSCOUNT (2), ARCOUNT (2)
	flags := binary.BigEndian.Uint16(buf[2:4])
	ancount := binary.BigEndian.Uint16(buf[6:8])
	qdcount := binary.BigEndian.Uint16(buf[4:6])

	// We only care about response packets (flags & 0x8000 != 0)
	if flags&0x8000 == 0 {
		return
	}

	// Skip header (12 bytes)
	offset := 12

	// Skip question section (if any)
	for i := uint16(0); i < qdcount; i++ {
		_, newOffset, err := parseMdnsName(buf, offset)
		if err != nil {
			return
		}
		offset = newOffset + 4 // skip QTYPE (2) + QCLASS (2)
	}

	// Parse answer sections
	for i := uint16(0); i < ancount; i++ {
		if offset >= len(buf) {
			return
		}
		_, newOffset, err := parseMdnsName(buf, offset)
		if err != nil {
			offset++
			continue
		}
		offset = newOffset

		if offset+10 > len(buf) {
			return
		}
		rrType := binary.BigEndian.Uint16(buf[offset : offset+2])
		rrClass := binary.BigEndian.Uint16(buf[offset+2 : offset+4])
		_ = rrClass
		rdLength := binary.BigEndian.Uint16(buf[offset+8 : offset+10])
		offset += 10

		if offset+int(rdLength) > len(buf) {
			return
		}
		rdData := buf[offset : offset+int(rdLength)]
		offset += int(rdLength)

		// We look for PTR records matching _sharetool._tcp.local.
		// The PTR target name will be parsed in a follow-up record.
		// We also look for SRV records which have the actual port.
		switch rrType {
		case 12: // PTR record
			target, _, _ := parseMdnsName(buf, offset-int(rdLength))
			if strings.HasSuffix(target, "_sharetool._tcp.local.") {
				log.Printf("[mDNS] Found sharetool PTR: %s from %s", target, src.IP)
			}
		case 33: // SRV record (priority=2, weight=0, port=2, target=variable)
			if len(rdData) < 6 {
				continue
			}
			port := binary.BigEndian.Uint16(rdData[4:6])
			target, _, _ := parseMdnsName(rdData, 6)
			peerIP := src.IP.String()
			peerName := strings.TrimSuffix(target, ".")
			if peerName == "" {
				peerName = fmt.Sprintf("sharetool-%s", src.IP.String())
			}

			peer := Peer{
				Name:     peerName,
				IP:       peerIP,
				Port:     int(port),
				LastSeen: time.Now(),
			}

			key := fmt.Sprintf("%s:%d", peerIP, port)
			d.mu.Lock()
			_, exists := d.peers[key]
			d.peers[key] = peer
			d.mu.Unlock()

			if !exists {
				log.Printf("[mDNS] Discovered peer: %s (%s:%d) [%s]", peerName, peerIP, port, d.iface.Name)
				if d.callback != nil {
					d.callback(peer)
				}
			}
		case 16: // TXT record
			// Parse key=value pairs from TXT record
			txtOffset := 0
			for txtOffset < len(rdData) {
				if txtOffset >= len(rdData) {
					break
				}
				txtLen := int(rdData[txtOffset])
				txtOffset++
				if txtOffset+txtLen > len(rdData) {
					break
				}
				txtPair := string(rdData[txtOffset : txtOffset+txtLen])
				txtOffset += txtLen
				// Look for name=VALUE
				if strings.HasPrefix(txtPair, "name=") {
					nameVal := strings.TrimPrefix(txtPair, "name=")
					key := fmt.Sprintf("%s:%d", src.IP.String(), d.localPort)
					d.mu.Lock()
					if p, ok := d.peers[key]; ok {
						p.Name = nameVal
						d.peers[key] = p
						log.Printf("[mDNS] Peer %s:%d renamed to %s", src.IP.String(), d.localPort, nameVal)
					}
					d.mu.Unlock()
				}
			}
		}
	}
}

// advertiseLoop periodically sends mDNS announcement (service advertisement)
func (d *Discovery) advertiseLoop() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Send initial announcement
	d.sendAnnouncement()

	for {
		select {
		case <-ticker.C:
			d.sendAnnouncement()
		case <-d.stopCh:
			return
		}
	}
}

// sendAnnouncement sends a proper mDNS service announcement
func (d *Discovery) sendAnnouncement() {
	packet := buildMdnsAnnouncement(d.localPort, d.localName)
	addr := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	_, err := d.conn.WriteToUDP(packet, addr)
	if err != nil {
		log.Printf("[mDNS] Announcement send failed: %v", err)
	}
}

// buildMdnsAnnouncement builds a proper mDNS announcement packet
// with PTR + SRV + TXT records for _sharetool._tcp.local.
func buildMdnsAnnouncement(port int, name string) []byte {
	buf := make([]byte, 0, 512)

	// mDNS header (12 bytes) for a response
	buf = append(buf, 0, 0)           // Transaction ID
	buf = append(buf, 0x84, 0x00)   // Flags: response, recursion desired
	buf = append(buf, 0, 0)          // QDCOUNT = 0
	buf = append(buf, 0, 3)          // ANCOUNT = 3 (PTR, SRV, TXT)

	// PTR record: _sharetool._tcp.local -> <instance>. _sharetool._tcp.local
	ptrName := "_sharetool._tcp.local."
	instanceName := name + "._sharetool._tcp.local."
	buf = appendMdnsRecord(buf, ptrName, 12, 120, instanceName)

	// SRV record: <instance>. _sharetool._tcp.local -> port + target
	buf = appendMdnsRecordWithSRV(buf, instanceName, 33, 120, port, name+".local.")

	// TXT record: <instance>. _sharetool._tcp.local -> name=VALUE
	txtData := "name=" + name
	buf = appendMdnsRecord(buf, instanceName, 16, 120, txtData)

	return buf
}

func appendMdnsRecord(buf []byte, name string, rrtype uint16, ttl uint32, rdata string) []byte {
	// Name
	for _, label := range strings.Split(name, ".") {
		buf = append(buf, byte(len(label)))
		buf = append(buf, label...)
	}
	buf = append(buf, 0) // null terminator

	// Type (2), Class (2), TTL (4), RDLENGTH (2)
	buf = append(buf, 0, byte(rrtype>>8), 0, byte(rrtype&0xFF))
	buf = append(buf, 0, 0x80|0x01) // CLASS IN, cache-flush
	buf = append(buf, byte(ttl>>24), byte(ttl>>16), byte(ttl>>8), byte(ttl))

	// Encode rdata as name pointer or string
	var rd []byte
	if rrtype == 12 {
		// PTR: encode as compressed name
		rd = appendMdnsNameComp(rd, rdata)
	} else if rrtype == 16 {
		// TXT: length byte + string
		rd = append(rd, byte(len(rdata)))
		rd = append(rd, rdata...)
	}

	buf = append(buf, byte(len(rd)>>8), byte(len(rd)&0xFF))
	buf = append(buf, rd...)
	return buf
}

func appendMdnsRecordWithSRV(buf []byte, name string, rrtype uint16, ttl uint32, port int, target string) []byte {
	for _, label := range strings.Split(name, ".") {
		buf = append(buf, byte(len(label)))
		buf = append(buf, label...)
	}
	buf = append(buf, 0)

	buf = append(buf, 0, byte(rrtype>>8), 0, byte(rrtype&0xFF))
	buf = append(buf, 0, 0x80|0x01)
	buf = append(buf, byte(ttl>>24), byte(ttl>>16), byte(ttl>>8), byte(ttl))

	// SRV RDATA: priority(2) + weight(2) + port(2) + target
	rd := make([]byte, 0)
	rd = append(rd, 0, 0)                    // priority
	rd = append(rd, 0, 0)                    // weight
	rd = append(rd, byte(port>>8), byte(port&0xFF)) // port
	rd = appendMdnsNameComp(rd, target)      // target

	buf = append(buf, byte(len(rd)>>8), byte(len(rd)&0xFF))
	buf = append(buf, rd...)
	return buf
}

func appendMdnsNameComp(buf []byte, name string) []byte {
	for _, label := range strings.Split(name, ".") {
		buf = append(buf, byte(len(label)))
		buf = append(buf, label...)
	}
	buf = append(buf, 0)
	return buf
}

// GetLocalIP returns the best LAN IP for this machine
func GetLocalIP() string {
	iface, err := defaultInterface()
	if err != nil {
		return "unknown"
	}
	addrs, _ := iface.Addrs()
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok {
			if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
				return ip4.String()
			}
		}
	}
	return "unknown"
}

func defaultInterface() (*net.Interface, error) {
	intfs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, intf := range intfs {
		if intf.Flags&net.FlagUp == 0 || intf.Flags&net.FlagLoopback != 0 {
			continue
		}
		if intf.Flags&net.FlagMulticast == 0 {
			continue
		}
		addrs, _ := intf.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
					return &intf, nil
				}
			}
		}
	}
	return nil, fmt.Errorf("no suitable interface")
}

func hostname() string {
	h, _ := os.Hostname()
	if h == "" {
		h = "unknown"
	}
	// Trim domain part if present
	if idx := strings.Index(h, "."); idx != -1 {
		h = h[:idx]
	}
	return h
}

func buildMdnsQuery(name string) []byte {
	// Build proper mDNS query packet
	buf := make([]byte, 0, 64)

	// mDNS header (12 bytes)
	buf = append(buf, 0, 0)           // Transaction ID (0)
	buf = append(buf, 0, 0)           // Flags: standard query (0)
	buf = append(buf, 0, 1)          // QDCOUNT = 1
	buf = append(buf, 0, 0)          // ANCOUNT = 0
	buf = append(buf, 0, 0)          // NSCOUNT = 0
	buf = append(buf, 0, 0)          // ARCOUNT = 0

	// Question section
	for _, label := range strings.Split(name, ".") {
		buf = append(buf, byte(len(label)))
		buf = append(buf, label...)
	}
	buf = append(buf, 0)    // null terminator
	buf = append(buf, 0, 12) // QTYPE: PTR
	buf = append(buf, 0, 1)  // QCLASS: IN

	return buf
}
