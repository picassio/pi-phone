// agy-tls: Google Antigravity's requests made with Go's own HTTP and TLS stack, as agy (a Go program) makes them, so the
// handshake and the request line up with agy's (PP-559; measured against agy 1.5.15: JA4 t13d1312h1_f57a46bbacb6_f50d94e863eb).
//
// Usage: agy-tls <socket-path> [--allow=host:port ...]
//
// The server (src/server/agy-tls-proxy.ts) sends HTTP/1.1 requests on the Unix socket with the address to reach in
// X-Agy-Target. Only https addresses on googleapis.com are reached; --allow adds a host:port reached over plain http
// (the tests' local server). The request goes out as Go's client writes it: Host, User-Agent, Content-Length, the other
// headers, then Accept-Encoding: gzip, which the client adds itself and answers by unzipping the response. Hop-by-hop
// headers of the socket's request (Connection, Keep-Alive, Transfer-Encoding...) are not passed on. The process ends
// when its standard input closes: the server that started it is gone.
//
// For HTTP/2 requests (Clearcut telemetry), set X-Agy-Proto: h2. The request uses Go's HTTP/2 client with the same
// TLS configuration, matching agy's HTTP/2 fingerprint.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/http2"
)

// agy's key exchange groups, in its order: X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024, X25519, P-256,
// P-384, P-521. The ML-KEM ones need Go 1.26 or later (go.mod).
var agyCurves = []tls.CurveID{
	tls.X25519MLKEM768,
	tls.SecP256r1MLKEM768,
	tls.SecP384r1MLKEM1024,
	tls.X25519,
	tls.CurveP256,
	tls.CurveP384,
	tls.CurveP521,
}

// Headers of the socket's request that are not the upstream request's.
var hopByHop = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Connection":    true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
	"Content-Length":      true,
	"X-Agy-Target":        true,
	"X-Agy-Dial":          true,
	"X-Agy-Proto":         true,
}

// The address the server's own lookup gave for a request's host (X-Agy-Dial): on Android there is no /etc/resolv.conf,
// so Go's resolver (no cgo) would ask [::1]:53 and fail; the system's resolver (its private DNS, a VPN) answers instead.
type dialTo struct{ host, ip string }

type dialKey struct{}

var dialer = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

func dial(ctx context.Context, network, addr string) (net.Conn, error) {
	if to, ok := ctx.Value(dialKey{}).(dialTo); ok {
		if host, port, err := net.SplitHostPort(addr); err == nil && strings.EqualFold(host, to.host) {
			return dialer.DialContext(ctx, network, net.JoinHostPort(to.ip, port))
		}
	}
	return dialer.DialContext(ctx, network, addr)
}

// HTTP/1.1 client for Cloud Code API calls (agy's main traffic).
var client = &http.Client{
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:       tls.VersionTLS12,
			MaxVersion:       tls.VersionTLS13,
			CurvePreferences: agyCurves,
			NextProtos:       []string{"http/1.1"},
		},
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         dial,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// HTTP/2 client for Clearcut telemetry (play.googleapis.com/log).
// Uses Go's HTTP/2 transport with the same TLS config as agy.
var clientH2 = &http.Client{
	Transport: &http2.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion:       tls.VersionTLS12,
			MaxVersion:       tls.VersionTLS13,
			CurvePreferences: agyCurves,
			NextProtos:       []string{"h2"},
		},
		DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
			// Use our custom dialer for DNS resolution on Android
			rawConn, err := dial(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			host, _, _ := net.SplitHostPort(addr)
			tlsConn := tls.Client(rawConn, &tls.Config{
				MinVersion:       tls.VersionTLS12,
				MaxVersion:       tls.VersionTLS13,
				CurvePreferences: agyCurves,
				NextProtos:       []string{"h2"},
				ServerName:       host,
			})
			if err := tlsConn.HandshakeContext(ctx); err != nil {
				rawConn.Close()
				return nil, err
			}
			return tlsConn, nil
		},
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// The plain-http hosts --allow adds (tests only).
var allowed = map[string]bool{}

// Whether the address may be reached: https on googleapis.com, or a host:port --allow named.
func reachable(target *url.URL) bool {
	host := strings.ToLower(target.Hostname())
	if target.Scheme == "https" && (host == "googleapis.com" || strings.HasSuffix(host, ".googleapis.com")) {
		return true
	}
	return allowed[target.Host]
}

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
		if !forward(conn, req) {
			return
		}
	}
}

// Sends one request upstream and writes its response to the socket; false when the socket is no longer usable.
func forward(conn net.Conn, req *http.Request) bool {
	defer req.Body.Close()
	targetURL := req.Header.Get("X-Agy-Target")
	target, err := url.Parse(targetURL)
	if targetURL == "" || err != nil {
		writeError(conn, 400, "X-Agy-Target is not an address")
		return drain(req)
	}
	if !reachable(target) {
		writeError(conn, 403, "agy-tls reaches only https addresses on googleapis.com: not "+target.Host)
		return drain(req)
	}

	// Choose HTTP/1.1 or HTTP/2 based on X-Agy-Proto header
	useH2 := strings.EqualFold(req.Header.Get("X-Agy-Proto"), "h2")
	httpClient := client
	if useH2 {
		httpClient = clientH2
	}

	ctx := req.Context()
	if ip := net.ParseIP(req.Header.Get("X-Agy-Dial")); ip != nil {
		ctx = context.WithValue(ctx, dialKey{}, dialTo{host: target.Hostname(), ip: ip.String()})
	}
	out, err := http.NewRequestWithContext(ctx, req.Method, targetURL, req.Body)
	if err != nil {
		writeError(conn, 500, fmt.Sprintf("request: %v", err))
		return drain(req)
	}
	// The body's length, as agy sends it, never chunked.
	out.ContentLength = req.ContentLength
	if req.ContentLength == 0 {
		out.Body = http.NoBody
	}
	for name, values := range req.Header {
		if hopByHop[name] {
			continue
		}
		// gzip is what Go's client asks for by itself, last, unzipping the answer: left to it, as in agy.
		if name == "Accept-Encoding" && len(values) == 1 && strings.EqualFold(values[0], "gzip") {
			continue
		}
		out.Header[name] = values
	}
	if out.Header.Get("User-Agent") == "" {
		// Go's own, as agy's OAuth calls send it, rather than none.
		if useH2 {
			out.Header["User-Agent"] = []string{"Go-http-client/2.0"}
		} else {
			out.Header["User-Agent"] = []string{"Go-http-client/1.1"}
		}
	}
	resp, err := httpClient.Do(out)
	if err != nil {
		writeError(conn, 502, fmt.Sprintf("upstream: %v", err))
		// What is left of the body is unknown: the connection closes, the next request opens another.
		return false
	}
	defer resp.Body.Close()
	// Streamed back as it comes (Server-Sent Events): chunked to the socket, flushed by each write.
	resp.Header.Del("Connection")
	return resp.Write(conn) == nil
}

// Reads what is left of a refused request's body, so the next request on the connection can be read.
func drain(req *http.Request) bool {
	_, err := io.Copy(io.Discard, req.Body)
	return err == nil
}

func writeError(conn net.Conn, code int, msg string) {
	resp := &http.Response{
		StatusCode:    code,
		Status:        strconv.Itoa(code) + " " + http.StatusText(code),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": []string{"text/plain"}, "X-Agy-Tls": []string{"refused"}},
		Body:          io.NopCloser(strings.NewReader(msg)),
		ContentLength: int64(len(msg)),
	}
	resp.Write(conn)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: agy-tls <socket-path> [--allow=host:port ...]")
		os.Exit(2)
	}
	socketPath := os.Args[1]
	for _, arg := range os.Args[2:] {
		if strings.HasPrefix(arg, "--allow=") {
			allowed[strings.TrimPrefix(arg, "--allow=")] = true
		}
	}

	// Remove stale socket file if it exists
	os.Remove(socketPath)

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	defer listener.Close()
	defer os.Remove(socketPath)

	// End when stdin closes (the server that started us is gone) or on SIGTERM/SIGINT.
	go func() {
		io.Copy(io.Discard, os.Stdin)
		listener.Close()
	}()
	go func() {
		c := make(chan os.Signal, 1)
		signal.Notify(c, syscall.SIGTERM, syscall.SIGINT)
		<-c
		listener.Close()
	}()

	fmt.Fprintf(os.Stderr, "listening on %s\n", socketPath)
	for {
		conn, err := listener.Accept()
		if err != nil {
			break
		}
		go handleConnection(conn)
	}
}
