package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"sharetool/internal/discovery"
	"sharetool/internal/server"
)

var httpClient = &http.Client{Timeout: 5 * time.Second}

func main() {
	port := flag.Int("port", 18793, "Port to run the server on (HTTP)")
	dir := flag.String("dir", "./shared", "Directory to store and share files")
	name := flag.String("name", "", "Human-readable name for this instance (e.g., 'my-mac')")
	register := flag.Bool("register", false, "If set, register this instance with itself")
	readonly := flag.Bool("readonly", false, "If set, disable file upload and delete")
	flag.Parse()

	// Default name to hostname if not specified
	if *name == "" {
		hostname, err := os.Hostname()
		if err != nil {
			*name = "unknown"
		} else {
			*name = hostname
		}
	}

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
				// Register discovered peer with server
				server.RegisterPeer(peer.IP, peer.Port, peer.Name)
			}); err != nil {
				log.Printf("[mDNS] Discovery failed: %v (non-fatal)", err)
			}
		}()
	}

	router := server.SetupRouter(*dir, *readonly)
	wrappedHandler := server.SecurityMiddleware(server.WrapWithCORS(router))

	// Set instance info for clipboard API
	server.SetInstanceInfo(*name, localIP, *port)

	// Set clipboard data directory for persistence
	clipboardDir := filepath.Join(os.Getenv("HOME"), ".sharetool", "clipboard")
	if err := os.MkdirAll(clipboardDir, 0755); err != nil {
		log.Printf("[Clipboard] Warning: failed to create data dir: %v", err)
	} else {
		server.SetDataDir(clipboardDir)
		log.Printf("[Clipboard] Data dir: %s", clipboardDir)
	}

	// Set upload temp directory
	uploadDir := filepath.Join(os.Getenv("HOME"), ".sharetool", "uploads")
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Printf("[Upload] Warning: failed to create upload dir: %v", err)
	} else {
		server.SetUploadStoreDir(uploadDir)
		server.InitUploadCleanup(0) // 0 = use default 7-day threshold
		log.Printf("[Upload] Store dir: %s", uploadDir)
	}

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("ShareTool running on http://0.0.0.0%s", addr)
	log.Printf("Sharing directory: %s", *dir)
	log.Printf("Local IP: %s", localIP)
	log.Printf("Instance name: %s", *name)
	if *readonly {
		log.Printf("Mode: READONLY")
	}

	if *register && *name != "" {
		go func() {
			time.Sleep(1 * time.Second)
			registerPeer(localIP, *port, *name)
		}()
	}

	srv := &http.Server{
		Addr:    addr,
		Handler: wrappedHandler,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down ShareTool...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	log.Println("ShareTool stopped")
}

func registerPeer(ip string, port int, name string) {
	url := fmt.Sprintf("http://%s:%d/api/peers", ip, port)
	payload := map[string]any{"name": name, "ip": ip, "port": port}
	data, _ := json.Marshal(payload)
	resp, err := httpClient.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		log.Printf("[Peers] Failed to register with %s: %v", url, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		log.Printf("[Peers] Successfully registered as '%s' at %s:%d", name, ip, port)
	}
}
