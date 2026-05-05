package discovery

import (
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// Advertiser announces this ShareTool instance via mDNS/DNS-SD.
// It registers the _sharetool._tcp.local. service so that macOS NWBrowser
// and other Bonjour-compatible clients can discover it automatically.
type Advertiser struct {
	iface     *net.Interface
	conn      *net.UDPConn
	localIP   string
	localPort int
	localName string
	stopCh    chan struct{}
	wg        sync.WaitGroup
}

// NewAdvertiser creates an Advertiser for the given local IP, port, and instance name.
func NewAdvertiser(localIP string, localPort int, localName string) (*Advertiser, error) {
	iface, err := DefaultInterface()
	if err != nil {
		return nil, fmt.Errorf("mDNS advertiser: no suitable interface: %v", err)
	}
	return &Advertiser{
		iface:     iface,
		localIP:   localIP,
		localPort: localPort,
		localName: localName,
		stopCh:    make(chan struct{}),
	}, nil
}

// Start begins the mDNS advertisement — it listens for queries and responds
// with DNS-SD service advertisement packets.
func (a *Advertiser) Start() error {
	addr := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}

	conn, err := net.ListenMulticastUDP("udp4", a.iface, addr)
	if err != nil {
		return fmt.Errorf("mDNS advertiser: listen multicast UDP: %v", err)
	}
	a.conn = conn

	log.Printf("[mDNS] Advertiser listening on %s (port 5353)", a.iface.Name)

	a.wg.Add(2)
	go a.queryLoop()
	go a.announceLoop()

	return nil
}

// Stop shuts down the advertiser.
func (a *Advertiser) Stop() {
	close(a.stopCh)
	if a.conn != nil {
		a.conn.Close()
	}
	a.wg.Wait()
	log.Println("[mDNS] Advertiser stopped")
}

// queryLoop listens for incoming mDNS queries and responds if they ask for _sharetool._tcp.
func (a *Advertiser) queryLoop() {
	defer a.wg.Done()
	buf := make([]byte, 65536)
	for {
		select {
		case <-a.stopCh:
			return
		default:
			a.conn.SetReadDeadline(time.Now().Add(1 * time.Second))
			n, src, err := a.conn.ReadFromUDP(buf)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				continue
			}
			a.handleQuery(buf[:n], src)
		}
	}
}

// announceLoop sends periodic unsolicited announcements on startup (good citizenship per RFC 6762).
func (a *Advertiser) announceLoop() {
	defer a.wg.Done()

	// Send initial burst of 3 announcements spaced 1 second apart (RFC 6762 §8.3)
	for i := 0; i < 3; i++ {
		a.sendGoodbye()
		select {
		case <-a.stopCh:
			return
		case <-time.After(1 * time.Second):
		}
	}

	// Then re-announce every 60 minutes (RFC 6762 §8.3 suggests "at least every hour")
	ticker := time.NewTicker(60 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
			a.sendGoodbye()
		}
	}
}

// handleQuery checks if the incoming packet is a query for _sharetool._tcp.local.
// If so, it sends a unicast response with the service advertisement.
func (a *Advertiser) handleQuery(query []byte, src *net.UDPAddr) {
	if len(query) < 12 {
		return
	}

	// Parse mDNS header
	flags := binary.BigEndian.Uint16(query[2:4])
	// Standard query: flags low bit = 0; response: flags high bit = 1
	if flags&0x8000 != 0 {
		return // This is a response, not a query — ignore
	}

	qdcount := binary.BigEndian.Uint16(query[4:6])
	if qdcount == 0 {
		return
	}

	// Parse question section to find the QNAME
	offset := 12
	var qnameParts []string
	for i := 0; i < 16 && offset < len(query); i++ {
		length := int(query[offset])
		if length == 0 {
			offset++
			break
		}
		if offset+1+length > len(query) {
			return
		}
		qnameParts = append(qnameParts, string(query[offset+1:offset+1+length]))
		offset += 1 + length
	}

	qname := strings.Join(qnameParts, ".")
	if !strings.HasSuffix(qname, "_sharetool._tcp.local.") && qname != "_sharetool._tcp.local." {
		return // Not our service — ignore
	}

	log.Printf("[mDNS] Query for %s from %s — responding with advertisement", qname, src.IP)
	a.sendResponse(src)
}

// sendResponse sends a DNS-SD service advertisement via unicast to the querier.
func (a *Advertiser) sendResponse(dst *net.UDPAddr) {
	packet := a.buildDNSResponse()
	addr := &net.UDPAddr{IP: dst.IP, Port: 5353}
	a.conn.WriteToUDP(packet, addr)
}

// sendGoodbye sends an unsolicited announcement (used on startup and periodically).
func (a *Advertiser) sendGoodbye() {
	packet := a.buildDNSResponse()
	addr := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	_, err := a.conn.WriteToUDP(packet, addr)
	if err != nil {
		log.Printf("[mDNS] Goodbye send failed: %v", err)
	}
}

// buildDNSResponse builds a minimal mDNS response packet with PTR, SRV, and TXT records.
func (a *Advertiser) buildDNSResponse() []byte {
	serviceInstance := fmt.Sprintf("%s._sharetool._tcp.local.", a.localName)

	var pkt []byte

	// --- mDNS Header (12 bytes) ---
	// Transaction ID (2), Flags (2), QDCOUNT (2), ANCOUNT (2), NSCOUNT (2), ARCOUNT (2)
	pkt = append(pkt, 0, 0)         // Transaction ID: 0
	pkt = append(pkt, 0x84, 0x00)   // Flags: response (0x8000), authoritative (0x0400) → 0x8400
	pkt = append(pkt, 0, 0)         // Question count: 0
	pkt = append(pkt, 0, 3)         // Answer count: 3 (PTR, SRV, TXT)
	pkt = append(pkt, 0, 0)         // Authority count: 0
	pkt = append(pkt, 0, 0)         // Additional count: 0

	// Helper: encode a DNS name as length-prefixed labels
	encodeName := func(name string) []byte {
		var out []byte
		for _, label := range strings.Split(name, ".") {
			if label == "" {
				continue
			}
			out = append(out, byte(len(label)))
			out = append(out, label...)
		}
		out = append(out, 0) // null terminator
		return out
	}

	// Encode names we'll reuse
	serviceType := "_sharetool._tcp.local."
	ptrNameData := encodeName(serviceType)
	srvNameData := encodeName(serviceInstance)
	hostTarget := fmt.Sprintf("%s.local.", a.localName)
	hostTargetData := encodeName(hostTarget)

	// DNS record TTL: 300 seconds in network byte order (big-endian 4 bytes)
	ttl := []byte{0x00, 0x00, 0x01, 0x2C} // 300 = 0x12C → 4 bytes: 0x00 0x00 0x01 0x2C

	// --- Answer 1: PTR record ---
	// _sharetool._tcp.local.  IN  PTR  <instance>._sharetool._tcp.local.
	pkt = append(pkt, ptrNameData...)
	pkt = append(pkt, 0, 12) // Type: PTR
	pkt = append(pkt, 0, 1)  // Class: IN
	pkt = append(pkt, ttl...)
	pkt = append(pkt, byte(len(srvNameData)>>8), byte(len(srvNameData)&0xFF)) // RDLENGTH
	pkt = append(pkt, srvNameData...)

	// --- Answer 2: SRV record ---
	// <instance>._sharetool._tcp.local.  IN  SRV  0 0 18793 <host>.local.
	srvRData := []byte{0, 0}                               // Priority: 0
	srvRData = append(srvRData, 0, 0)                      // Weight: 0
	srvRData = append(srvRData, byte(a.localPort>>8), byte(a.localPort&0xFF)) // Port
	srvRData = append(srvRData, hostTargetData...)

	pkt = append(pkt, srvNameData...)
	pkt = append(pkt, 0, 33) // Type: SRV
	pkt = append(pkt, 0, 1)  // Class: IN
	pkt = append(pkt, ttl...)
	pkt = append(pkt, byte(len(srvRData)>>8), byte(len(srvRData)&0xFF)) // RDLENGTH
	pkt = append(pkt, srvRData...)

	// --- Answer 3: TXT record ---
	// <instance>._sharetool._tcp.local.  IN  TXT  ""
	// Empty TXT record: one null byte (representing empty string)
	txtRData := []byte{0}

	pkt = append(pkt, srvNameData...)
	pkt = append(pkt, 0, 16) // Type: TXT
	pkt = append(pkt, 0, 1)  // Class: IN
	pkt = append(pkt, ttl...)
	pkt = append(pkt, byte(len(txtRData)>>8), byte(len(txtRData)&0xFF)) // RDLENGTH
	pkt = append(pkt, txtRData...)

	return pkt
}
