package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"

	"sharetool/internal/discovery"
	"sharetool/internal/server"
)

func main() {
	port := flag.Int("port", 18790, "Port to run the server on")
	dir := flag.String("dir", "./shared", "Directory to store and share files")
	flag.Parse()

	if err := os.MkdirAll(*dir, 0755); err != nil {
		log.Fatalf("Failed to create share directory: %v", err)
	}

	// Start mDNS broadcast
	go func() {
		if err := discovery.Start(*port); err != nil {
			log.Printf("[mDNS] Broadcast failed: %v (non-fatal)", err)
		}
	}()

	router := server.SetupRouter(*dir)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("ShareTool running on http://0.0.0.0%s", addr)
	log.Printf("Sharing directory: %s", *dir)
	log.Printf("Local IP: %s", discovery.GetLocalIP())

	if err := http.ListenAndServe(addr, router); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
