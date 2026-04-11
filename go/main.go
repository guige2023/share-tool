package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"sharetool/internal/discovery"
	"sharetool/internal/server"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func main() {
	port := flag.Int("port", 18790, "Port to run the server on")
	dir := flag.String("dir", "./shared", "Directory to store and share files")
	name := flag.String("name", "", "Human-readable name for this instance (e.g., 'my-mac')")
	register := flag.Bool("register", false, "If set, register this instance with itself")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0755); err != nil {
		log.Fatalf("Failed to create share directory: %v", err)
	}

	localIP := discovery.GetLocalIP()

	// Start mDNS discovery
	d, err := discovery.New(*port)
	if err != nil {
		log.Printf("[mDNS] Failed to create discovery: %v (non-fatal)", err)
	} else {
		go func() {
			if err := d.Start(func(peer discovery.Peer) {
				log.Printf("[mDNS] Discovered peer: %s:%d", peer.IP, peer.Port)
			}); err != nil {
				log.Printf("[mDNS] Discovery failed: %v (non-fatal)", err)
			}
		}()
	}

	router := server.SetupRouter(*dir)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("ShareTool running on http://0.0.0.0%s", addr)
	log.Printf("Sharing directory: %s", *dir)
	log.Printf("Local IP: %s", localIP)
	if *name != "" {
		log.Printf("Instance name: %s", *name)
	}

	// Register with self if --register flag is set
	if *register && *name != "" {
		go func() {
			time.Sleep(1 * time.Second) // Wait for server to start
			registerPeer(localIP, *port, *name)
		}()
	}

	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func registerPeer(ip string, port int, name string) {
	url := fmt.Sprintf("http://%s:%d/api/peers", ip, port)
	payload := map[string]any{"name": name, "ip": ip, "port": port}
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[Peers] Failed to marshal registration: %v", err)
		return
	}
	resp, err := httpClient.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		log.Printf("[Peers] Failed to register with %s: %v", url, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		log.Printf("[Peers] Successfully registered as '%s' at %s:%d", name, ip, port)
	} else {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[Peers] Registration failed with status %d: %s", resp.StatusCode, string(body))
	}
}
