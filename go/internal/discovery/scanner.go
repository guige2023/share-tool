package discovery

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

// Scanner performs active TCP scans of the LAN to discover ShareTool instances
type Scanner struct {
	port      int
	peers     map[string]Peer
	mu        sync.RWMutex
	stopCh    chan struct{}
	callback  PeerCallback
	localPort int
	localName string
}

// NewScanner creates a new LAN scanner
func NewScanner(port int, callback PeerCallback) *Scanner {
	return &Scanner{
		port:      port,
		peers:     make(map[string]Peer),
		stopCh:    make(chan struct{}),
		callback:  callback,
		localPort: port,
	}
}

// Start begins active scanning of the local subnet
func (s *Scanner) Start() error {
	localIP := GetLocalIP()
	if localIP == "unknown" {
		return fmt.Errorf("cannot determine local IP")
	}

	// Get subnet
	subnet, err := GetLocalSubnet()
	if err != nil {
		log.Printf("[Scanner] Cannot determine subnet: %v", err)
		return err
	}

	log.Printf("[Scanner] Starting scan of %s for ShareTool on port %d", subnet, s.port)

	// Run initial scan
	go s.runScan(subnet)

	// Run periodic scans every 60 seconds
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.runScan(subnet)
			case <-s.stopCh:
				return
			}
		}
	}()

	return nil
}

// Stop halts the scanner
func (s *Scanner) Stop() {
	close(s.stopCh)
}

// runScan performs a TCP scan of the given subnet ( CIDR notation)
func (s *Scanner) runScan(subnet string) {
	_, ipnet, err := net.ParseCIDR(subnet)
	if err != nil {
		log.Printf("[Scanner] Invalid subnet: %v", err)
		return
	}

	// Calculate all IPs in the subnet (simplified for /24)
	ip := ipnet.IP.To4()
	if ip == nil {
		log.Printf("[Scanner] Only IPv4 subnets supported")
		return
	}

	// For /24 subnet, iterate through .1 to .254
	// Extract base IP
	baseIP := [4]byte{ip[0], ip[1], ip[2], 0}

	localIP := GetLocalIP()

	// Create a channel for results
	type scanResult struct {
		ip   string
		port int
		name string
	}
	resultCh := make(chan scanResult, 254)

	// Scan in parallel with limited concurrency
	sem := make(chan struct{}, 50) // max 50 concurrent scans

	var wg sync.WaitGroup
	for i := 1; i < 255; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			targetIP := fmt.Sprintf("%d.%d.%d.%d", baseIP[0], baseIP[1], baseIP[2], n)
			// Skip self
			if targetIP == localIP {
				return
			}

			if ok := s.probeHost(targetIP, s.port); ok {
				resultCh <- scanResult{ip: targetIP, port: s.port, name: targetIP}
			}
		}(i)
	}

	// Close result channel when done
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	// Collect results
	for result := range resultCh {
		peer := Peer{
			Name:     result.name,
			IP:       result.ip,
			Port:     result.port,
			LastSeen: time.Now(),
		}
		s.addPeer(peer)
	}
}

// probeHost attempts to connect to a ShareTool instance and retrieve its info
func (s *Scanner) probeHost(ip string, port int) bool {
	// Try HTTPS first, then HTTP
	urls := []string{
		fmt.Sprintf("https://%s:%d/api/peers", ip, port),
		fmt.Sprintf("http://%s:%d/api/peers", ip, port),
	}

	for _, url := range urls {
		resp, err := httpClient.Get(url)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode == 200 {
			// A 200 response means the host is a ShareTool instance
			log.Printf("[Scanner] Found ShareTool at %s:%d", ip, port)
			return true
		}
	}

	return false
}

// probeHostWithName attempts to get the peer name as well
func (s *Scanner) probeHostWithName(ip string, port int) (bool, string) {
	// Try HTTPS first
	url := fmt.Sprintf("https://%s:%d/api/peers", ip, port)
	resp, err := httpClient.Get(url)
	if err != nil {
		// Try HTTP
		url = fmt.Sprintf("http://%s:%d/api/peers", ip, port)
		resp, err = httpClient.Get(url)
		if err != nil {
			return false, ""
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return false, ""
	}

	return true, ip
}

func (s *Scanner) addPeer(peer Peer) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := peer.IP
	existing, exists := s.peers[key]
	if !exists || existing.Name != peer.Name || existing.Port != peer.Port {
		log.Printf("[Scanner] Found peer: %s (%s:%d)", peer.Name, peer.IP, peer.Port)
	}
	s.peers[key] = peer

	if s.callback != nil {
		s.callback(peer)
	}
}

// Peers returns all discovered peers
func (s *Scanner) Peers() []Peer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var peers []Peer
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	return peers
}

// ManualAdd adds a peer manually by IP and port
func (s *Scanner) ManualAdd(ip string, port int, name string) {
	if name == "" {
		name = ip
	}
	peer := Peer{
		Name:     name,
		IP:       ip,
		Port:     port,
		LastSeen: time.Now(),
	}
	s.mu.Lock()
	s.peers[ip] = peer
	s.mu.Unlock()
	log.Printf("[Scanner] Manually added peer: %s (%s:%d)", name, ip, port)
	if s.callback != nil {
		s.callback(peer)
	}
}

var httpClient = &http.Client{Timeout: 3 * time.Second}
