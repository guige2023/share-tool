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
	Name      string // hostname
	IP        string
	Port      int
	LastSeen  time.Time
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
		iface, err := DefaultInterface()
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

	// Set read deadline to avoid blocking forever
	d.conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))

	log.Printf("[mDNS] Listening on %s", d.iface.Name)

	// Send initial query
	go d.broadcastLoop()
	go d.listenLoop()

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

func (d *Discovery) handlePacket(buf []byte, src *net.UDPAddr) {
	// Skip if too short (min mDNS header is 12 bytes)
	if len(buf) < 12 {
		return
	}

	// Parse mDNS header
	// Transaction ID (2), Flags (2), QDCOUNT (2), ANCOUNT (2), NSCOUNT (2), ARCOUNT (2)
	flags := binary.BigEndian.Uint16(buf[2:4])
	ancount := binary.BigEndian.Uint16(buf[6:8])

	// We only care about response packets (flags & 0x8000 != 0)
	if flags&0x8000 == 0 || ancount == 0 {
		return
	}

	// Skip header (12 bytes) and parse question section to find answer
	// For a simple implementation, just record the source as a peer
	peer := Peer{
		Name:     src.IP.String(),
		IP:       src.IP.String(),
		Port:     d.localPort,
		LastSeen: time.Now(),
	}

	d.mu.Lock()
	key := src.IP.String()
	if _, exists := d.peers[key]; !exists && d.callback != nil {
		log.Printf("[mDNS] Discovered peer: %s", key)
	}
	d.peers[key] = peer
	d.mu.Unlock()
}

// GetLocalIP returns the best LAN IP for this machine
func GetLocalIP() string {
		iface, err := DefaultInterface()
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

// GetLocalSubnet returns the subnet in CIDR notation (e.g., "192.168.1.0/24")
func GetLocalSubnet() (string, error) {
		iface, err := DefaultInterface()
	if err != nil {
		return "", err
	}
	addrs, _ := iface.Addrs()
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok {
			if ip4 := ipnet.IP.To4(); ip4 != nil && !ip4.IsLoopback() {
				// Calculate subnet - assume /24 for typical LAN
				baseIP := net.IP{ip4[0], ip4[1], ip4[2], 0}.String()
				return baseIP + "/24", nil
			}
		}
	}
	return "", fmt.Errorf("no suitable interface")
}

// DefaultInterface returns the first active, multicast-capable, non-loopback interface.
func DefaultInterface() (*net.Interface, error) {
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
	buf = append(buf, 0, 1)           // QDCOUNT = 1
	buf = append(buf, 0, 0)           // ANCOUNT = 0
	buf = append(buf, 0, 0)           // NSCOUNT = 0
	buf = append(buf, 0, 0)           // ARCOUNT = 0

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
