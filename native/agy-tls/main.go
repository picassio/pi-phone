// agy-tls: A TLS proxy that makes HTTPS requests with Go's TLS stack (BoringSSL/boringcrypto),
// matching agy's exact TLS fingerprint including ML-KEM post-quantum key exchange.
//
// Usage: agy-tls <socket-path>
// Node connects to the Unix socket and sends HTTP/1.1 requests with header:
//   X-Agy-Target: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent
// The proxy makes the HTTPS request and streams the response back.

package main

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// agy's exact curve preferences as captured from agy 1.5.15:
// X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024, X25519, P-256, P-384, P-521
// IDs: 0x11ec (4588), 0x11eb (4587), 0x11ed (4589), 29, 23, 24, 25
var agyCurves = []tls.CurveID{
	tls.CurveID(0x11ec), // X25519MLKEM768
	tls.CurveID(0x11eb), // SecP256r1MLKEM768
	tls.CurveID(0x11ed), // SecP384r1MLKEM1024
	tls.X25519,
	tls.CurveP256,
	tls.CurveP384,
	tls.CurveP521,
}

// TLS config matching agy's exact fingerprint
func tlsConfigHTTP1() *tls.Config {
	return &tls.Config{
		MinVersion:       tls.VersionTLS12,
		MaxVersion:       tls.VersionTLS13,
		CurvePreferences: agyCurves,
		NextProtos:       []string{"http/1.1"},
	}
}

func tlsConfigHTTP2() *tls.Config {
	return &tls.Config{
		MinVersion:       tls.VersionTLS12,
		MaxVersion:       tls.VersionTLS13,
		CurvePreferences: agyCurves,
		NextProtos:       []string{"h2", "http/1.1"},
	}
}

func makeTransport(cfg *tls.Config) *http.Transport {
	return &http.Transport{
		TLSClientConfig:     cfg,
		Proxy:               http.ProxyFromEnvironment,
		DisableKeepAlives:   false,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
}

var (
	transportHTTP1 = makeTransport(tlsConfigHTTP1())
	transportHTTP2 = makeTransport(tlsConfigHTTP2())
)

func handleConnection(conn net.Conn) {
	defer conn.Close()

	reader := bufio.NewReader(conn)

	for {
		req, err := http.ReadRequest(reader)
		if err != nil {
			if err != io.EOF {
				fmt.Fprintf(os.Stderr, "read request: %v\n", err)
			}
			return
		}

		targetURL := req.Header.Get("X-Agy-Target")
		if targetURL == "" {
			writeError(conn, 400, "Missing X-Agy-Target header")
			continue
		}
		req.Header.Del("X-Agy-Target")

		target, err := url.Parse(targetURL)
		if err != nil {
			writeError(conn, 400, fmt.Sprintf("Invalid target URL: %v", err))
			continue
		}

		// HTTP/2 for Clearcut (play.googleapis.com), HTTP/1.1 for everything else
		transport := transportHTTP1
		if strings.Contains(target.Host, "play.googleapis.com") {
			transport = transportHTTP2
		}

		client := &http.Client{
			Transport: transport,
			Timeout:   5 * time.Minute,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}

		outReq, err := http.NewRequest(req.Method, targetURL, req.Body)
		if err != nil {
			writeError(conn, 500, fmt.Sprintf("Create request: %v", err))
			continue
		}

		for k, v := range req.Header {
			if strings.HasPrefix(k, "X-Agy-") {
				continue
			}
			outReq.Header[k] = v
		}

		resp, err := client.Do(outReq)
		if err != nil {
			writeError(conn, 502, fmt.Sprintf("Upstream: %v", err))
			continue
		}

		err = resp.Write(conn)
		resp.Body.Close()
		if err != nil {
			return
		}
	}
}

func writeError(conn net.Conn, code int, msg string) {
	resp := &http.Response{
		StatusCode:    code,
		Status:        fmt.Sprintf("%d %s", code, http.StatusText(code)),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": []string{"text/plain"}},
		Body:          io.NopCloser(strings.NewReader(msg)),
		ContentLength: int64(len(msg)),
	}
	resp.Write(conn)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: agy-tls <socket-path>")
		os.Exit(1)
	}

	socketPath := os.Args[1]
	os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	defer listener.Close()

	os.Chmod(socketPath, 0600)
	fmt.Fprintf(os.Stderr, "agy-tls listening on %s\n", socketPath)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Fprintln(os.Stderr, "shutting down")
		listener.Close()
		os.Remove(socketPath)
		os.Exit(0)
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if !strings.Contains(err.Error(), "use of closed") {
				fmt.Fprintf(os.Stderr, "accept: %v\n", err)
			}
			continue
		}
		go handleConnection(conn)
	}
}
