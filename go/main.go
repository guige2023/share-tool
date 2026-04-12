package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
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
	port := flag.Int("port", 18793, "Port to run the server on (HTTPS)")
	httpPort := flag.Int("http-port", 18790, "Port for plain HTTP (redirect or off)")
	dir := flag.String("dir", "./shared", "Directory to store and share files")
	name := flag.String("name", "", "Human-readable name for this instance (e.g., 'my-mac')")
	register := flag.Bool("register", false, "If set, register this instance with itself")
	readonly := flag.Bool("readonly", false, "If set, disable file upload and delete")
	noHttps := flag.Bool("no-https", false, "Disable HTTPS server")
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
			}); err != nil {
				log.Printf("[mDNS] Discovery failed: %v (non-fatal)", err)
			}
		}()
	}

	router := server.SetupRouter(*dir, *readonly)
	wrappedHandler := server.SecurityMiddleware(server.WrapWithCORS(router))

	if *noHttps {
		// Plain HTTP mode
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
		return
	}

	// HTTPS mode — generate self-signed cert if needed
	certFile := filepath.Join(os.Getenv("HOME"), ".share-tool", "cert.pem")
	keyFile := filepath.Join(os.Getenv("HOME"), ".share-tool", "key.pem")

	if _, err := os.Stat(certFile); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(certFile), 0700); err != nil {
			log.Fatalf("Failed to create cert directory: %v", err)
		}
		priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			log.Fatalf("Failed to generate private key: %v", err)
		}
		template := x509.Certificate{
			SerialNumber: big.NewInt(1),
			Subject: pkix.Name{
				Organization: []string{"ShareTool"},
				CommonName:   localIP,
			},
			NotBefore:             time.Now(),
			NotAfter:              time.Now().AddDate(10, 0, 0),
			KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			BasicConstraintsValid: true,
			IPAddresses:           []net.IP{net.ParseIP(localIP), net.ParseIP("127.0.0.1")},
		}
		certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
		if err != nil {
			log.Fatalf("Failed to create certificate: %v", err)
		}
		certOut, _ := os.Create(certFile)
		pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: certDER})
		certOut.Close()
		os.Chmod(certFile, 0644)

		// Marshal private key to PKCS#8
		pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			// Fall back to RSA key format for older Go versions
			rsaPriv := &rsa.PrivateKey{
				PublicKey: rsa.PublicKey{N: priv.Curve.Params().N, E: 65537},
				D:         new(big.Int).SetBytes(priv.D.Bytes()),
			}
			keyOut, _ := os.Create(keyFile)
			pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaPriv)})
			keyOut.Close()
		} else {
			keyOut, _ := os.Create(keyFile)
			pem.Encode(keyOut, &pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Bytes})
			keyOut.Close()
		}
		os.Chmod(keyFile, 0600)
		log.Printf("[TLS] Self-signed certificate generated: %s", certFile)
	}

	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Fatalf("Failed to load TLS certificate: %v", err)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}

	httpsAddr := fmt.Sprintf(":%d", *port)
	httpAddr := fmt.Sprintf(":%d", *httpPort)

	log.Printf("ShareTool running on https://0.0.0.0%s (TLS)", httpsAddr)
	log.Printf("HTTP redirect on http://0.0.0.0%s", httpAddr)
	log.Printf("Sharing directory: %s", *dir)
	log.Printf("Local IP: %s", localIP)
	log.Printf("Instance name: %s", *name)
	if *readonly {
		log.Printf("Mode: READONLY")
	}

	if *register && *name != "" {
		go func() {
			time.Sleep(1 * time.Second)
			registerPeerHTTPS(httpsAddr, localIP, *port, *name)
		}()
	}

	// HTTP → HTTPS redirect server
	httpSrv := &http.Server{
		Addr: httpAddr,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host, _, _ := net.SplitHostPort(r.Host)
			target := fmt.Sprintf("https://%s:%d%s", host, *port, r.URL.RequestURI())
			http.Redirect(w, r, target, http.StatusMovedPermanently)
		}),
	}

	// HTTPS server
	httpsSrv := &http.Server{
		Addr:    httpsAddr,
		Handler: wrappedHandler,
		TLSConfig: tlsConfig,
	}

	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server failed: %v", err)
		}
	}()

	go func() {
		if err := httpsSrv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTPS server failed: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down ShareTool...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	httpSrv.Shutdown(ctx)
	httpsSrv.Shutdown(ctx)
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
	} else {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[Peers] Registration failed with status %d: %s", resp.StatusCode, string(body))
	}
}

func registerPeerHTTPS(ip string, localIP string, port int, name string) {
	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	client := &http.Client{Transport: tr, Timeout: 5 * time.Second}
	url := fmt.Sprintf("https://%s:%d/api/peers", ip, port)
	payload := map[string]any{"name": name, "ip": localIP, "port": port}
	data, _ := json.Marshal(payload)
	resp, err := client.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		log.Printf("[Peers] Failed to register HTTPS with %s: %v", url, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		log.Printf("[Peers] Successfully registered HTTPS as '%s' at %s:%d", name, localIP, port)
	} else {
		body, _ := io.ReadAll(resp.Body)
		log.Printf("[Peers] HTTPS Registration failed with status %d: %s", resp.StatusCode, string(body))
	}
}
