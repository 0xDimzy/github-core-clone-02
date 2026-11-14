// net.go — a minimal HTTP/1.1 server over raw TCP.
// A faithful port of the v3 TypeScript net.ts: keep-alive, Content-Length
// and chunked bodies, Expect: 100-continue, one []byte write per response.
package main

import (
	"bytes"
	"fmt"
	"net"
	"strconv"
	"strings"
)

type httpRequest struct {
	method  string
	path    string
	query   map[string]string
	headers map[string]string
	body    []byte
	host    string
}

type httpResponse struct {
	status  int
	headers [][2]string
	body    []byte
	raw     []byte // when set, these exact bytes are written as-is
}

type handlerFunc func(req *httpRequest) *httpResponse

var statusText = map[int]string{
	200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
	400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
	405: "Method Not Allowed", 409: "Conflict", 422: "Unprocessable Entity",
	500: "Internal Server Error",
}

func renderResponse(res *httpResponse) []byte {
	var sb strings.Builder
	fmt.Fprintf(&sb, "HTTP/1.1 %d %s\r\n", res.status, statusText[res.status])
	for _, h := range res.headers {
		sb.WriteString(h[0])
		sb.WriteString(": ")
		sb.WriteString(h[1])
		sb.WriteString("\r\n")
	}
	fmt.Fprintf(&sb, "Connection: keep-alive\r\nContent-Length: %d\r\n\r\n", len(res.body))
	head := []byte(sb.String())
	if len(res.body) == 0 {
		return head
	}
	out := make([]byte, 0, len(head)+len(res.body))
	out = append(out, head...)
	out = append(out, res.body...)
	return out
}

func badRequestResponse() *httpResponse {
	return &httpResponse{status: 400, headers: [][2]string{{"Content-Type", "application/json"}}, body: []byte(`{"message":"Bad Request"}`)}
}

func internalErrorResponse() *httpResponse {
	return &httpResponse{status: 500, headers: [][2]string{{"Content-Type", "application/json"}}, body: []byte(`{"message":"internal error"}`)}
}

// parseQuery parses a query string the way URLSearchParams does for the
// shapes the suite sends: '&'-separated pairs, '+' decodes to space in
// values, invalid %-escapes stay literal, first value wins for .get().
func parseQuery(qs string) map[string]string {
	out := map[string]string{}
	if qs == "" {
		return out
	}
	for _, pair := range strings.Split(qs, "&") {
		if pair == "" {
			continue
		}
		k, v := pair, ""
		if i := strings.IndexByte(pair, '='); i >= 0 {
			k, v = pair[:i], pair[i+1:]
		}
		k = decodeQueryComponent(k)
		v = decodeQueryComponent(v)
		if _, ok := out[k]; !ok {
			out[k] = v
		}
	}
	return out
}

func decodeQueryComponent(s string) string {
	if !strings.ContainsAny(s, "+%") {
		return s
	}
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '+':
			sb.WriteByte(' ')
		case c == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]):
			sb.WriteByte(byte(hexVal(s[i+1])<<4 | hexVal(s[i+2])))
			i += 2
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// decodeURIComponentPath decodes %XX sequences; on any error the raw path
// is kept (like the TS try/catch).
func decodeURIComponentPath(p string) string {
	if !strings.Contains(p, "%") {
		return p
	}
	var sb strings.Builder
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '%' {
			if i+2 < len(p) && isHex(p[i+1]) && isHex(p[i+2]) {
				sb.WriteByte(byte(hexVal(p[i+1])<<4 | hexVal(p[i+2])))
				i += 2
			} else {
				return p
			}
		} else {
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

type bodyRead struct {
	body         []byte
	consumed     int
	sendContinue bool
	isNull       bool // need more data
}

// readChunkedBody mirrors net.ts's chunked reader.
func readChunkedBody(buf []byte, bodyStart int, expectContinue bool) bodyRead {
	off := bodyStart
	var chunks [][]byte
	for {
		eol := bytes.Index(buf[off:], []byte("\r\n"))
		if eol < 0 {
			if expectContinue {
				return bodyRead{sendContinue: true}
			}
			return bodyRead{isNull: true}
		}
		eol += off
		sizeLine := strings.TrimSpace(string(buf[off:eol]))
		if semi := strings.IndexByte(sizeLine, ';'); semi >= 0 {
			sizeLine = sizeLine[:semi]
		}
		size, err := strconv.ParseInt(sizeLine, 16, 64)
		if err != nil || size < 0 {
			panic("bad chunk size")
		}
		if off+(eol-off)+2+int(size)+2 > len(buf) {
			if expectContinue {
				return bodyRead{sendContinue: true}
			}
			return bodyRead{isNull: true}
		}
		off = eol + 2
		if size == 0 {
			trailerEnd := bytes.Index(buf[off:], []byte("\r\n\r\n"))
			singleEnd := bytes.Index(buf[off:], []byte("\r\n"))
			var end int
			switch {
			case trailerEnd >= 0:
				end = off + trailerEnd + 4
			case singleEnd >= 0:
				end = off + singleEnd + 2
			default:
				if expectContinue {
					return bodyRead{sendContinue: true}
				}
				return bodyRead{isNull: true}
			}
			var body []byte
			for _, c := range chunks {
				body = append(body, c...)
			}
			if body == nil {
				body = []byte{}
			}
			return bodyRead{body: body, consumed: end}
		}
		chunks = append(chunks, buf[off:off+int(size)])
		off += int(size) + 2
	}
}

func readLengthBody(buf []byte, bodyStart int, headers map[string]string, expectContinue bool) bodyRead {
	cl, err := strconv.Atoi(headers["content-length"])
	if err != nil {
		cl = 0
	}
	if cl < 0 {
		cl = 0
	}
	if len(buf) < bodyStart+cl {
		if expectContinue {
			return bodyRead{sendContinue: true}
		}
		return bodyRead{isNull: true}
	}
	var body []byte
	if cl == 0 {
		body = []byte{}
	} else {
		body = append([]byte{}, buf[bodyStart:bodyStart+cl]...)
	}
	return bodyRead{body: body, consumed: bodyStart + cl}
}

type parseResult struct {
	req          *httpRequest
	consumed     int
	sendContinue bool
	isNull       bool
}

// tryParse mirrors net.ts's tryParse: one complete request from buf's front.
func tryParse(buf []byte) (res parseResult) {
	defer func() {
		// A malformed request line / chunk size panics, like the TS throw;
		// the caller turns that into a 400 and closes.
		_ = res
	}()
	headEnd := bytes.Index(buf, []byte("\r\n\r\n"))
	if headEnd < 0 {
		return parseResult{isNull: true}
	}
	headText := string(buf[:headEnd])
	lines := strings.Split(headText, "\r\n")
	if len(lines) == 0 {
		panic("bad request line")
	}
	sp1 := strings.IndexByte(lines[0], ' ')
	sp2 := -1
	if sp1 >= 0 {
		sp2 = strings.IndexByte(lines[0][sp1+1:], ' ')
		if sp2 >= 0 {
			sp2 += sp1 + 1
		}
	}
	if sp1 < 0 || sp2 < 0 {
		panic("bad request line")
	}
	method := lines[0][:sp1]
	target := lines[0][sp1+1 : sp2]
	headers := map[string]string{}
	for _, line := range lines[1:] {
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		headers[strings.ToLower(strings.TrimSpace(line[:colon]))] = strings.TrimSpace(line[colon+1:])
	}
	expectContinue := strings.ToLower(headers["expect"]) == "100-continue"
	bodyStart := headEnd + 4
	te := strings.ToLower(headers["transfer-encoding"])
	if strings.Contains(te, "chunked") {
		read := readChunkedBody(buf, bodyStart, expectContinue)
		if read.isNull {
			return parseResult{isNull: true}
		}
		if read.sendContinue {
			return parseResult{sendContinue: true}
		}
		return parseResult{req: buildRequest(method, target, headers, read.body), consumed: read.consumed}
	}
	read := readLengthBody(buf, bodyStart, headers, expectContinue)
	if read.isNull {
		return parseResult{isNull: true}
	}
	if read.sendContinue {
		return parseResult{sendContinue: true}
	}
	return parseResult{req: buildRequest(method, target, headers, read.body), consumed: read.consumed}
}

func buildRequest(method, target string, headers map[string]string, body []byte) *httpRequest {
	path := target
	query := map[string]string{}
	if q := strings.IndexByte(target, '?'); q >= 0 {
		path = target[:q]
		query = parseQuery(target[q+1:])
	}
	if strings.Contains(path, "%") {
		path = decodeURIComponentPath(path)
	}
	host := headers["host"]
	if host == "" {
		host = "127.0.0.1"
	}
	return &httpRequest{method: method, path: path, query: query, headers: headers, body: body, host: host}
}

type connection struct {
	conn         net.Conn
	handler      handlerFunc
	buf          []byte
	closed       bool
	continueSent bool
	draining     bool
}

func (c *connection) writeResponse(req *httpRequest, res *httpResponse) bool {
	if c.closed {
		return false
	}
	if res.raw != nil {
		c.conn.Write(res.raw)
	} else {
		c.conn.Write(renderResponse(res))
	}
	if strings.ToLower(req.headers["connection"]) == "close" {
		c.conn.Close()
		c.closed = true
		return false
	}
	return true
}

func (c *connection) drain() {
	if c.draining {
		return
	}
	c.draining = true
	defer func() { c.draining = false }()
	for {
		if c.closed || len(c.buf) == 0 {
			return
		}
		var attempt parseResult
		func() {
			defer func() {
				if r := recover(); r != nil {
					// Malformed request line / chunk size: answer 400 and close.
					if !c.closed {
						c.conn.Write(renderResponse(badRequestResponse()))
						c.conn.Close()
					}
					c.closed = true
					attempt = parseResult{isNull: true}
				}
			}()
			attempt = tryParse(c.buf)
		}()
		if c.closed {
			return
		}
		if attempt.isNull {
			return
		}
		if attempt.sendContinue {
			if !c.continueSent {
				c.continueSent = true
				c.conn.Write([]byte("HTTP/1.1 100 Continue\r\n\r\n"))
			}
			return
		}
		req := attempt.req
		c.buf = c.buf[attempt.consumed:]
		c.continueSent = false
		res := func() (res *httpResponse) {
			defer func() {
				if r := recover(); r != nil {
					res = internalErrorResponse()
				}
			}()
			return c.handler(req)
		}()
		if res == nil {
			res = internalErrorResponse()
		}
		if !c.writeResponse(req, res) {
			return
		}
	}
}

func serveConn(conn net.Conn, handler handlerFunc) {
	conn.(*net.TCPConn).SetNoDelay(true)
	c := &connection{conn: conn, handler: handler}
	defer func() { c.closed = true }()
	tmp := make([]byte, 32768)
	for {
		n, err := conn.Read(tmp)
		if n > 0 {
			if len(c.buf) == 0 {
				c.buf = append([]byte{}, tmp[:n]...)
			} else {
				c.buf = append(c.buf, tmp[:n]...)
			}
			c.drain()
			if c.closed {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// createServer returns a listener serving handler on 127.0.0.1:port.
// port 0 lets the kernel pick. The caller reads the bound port from the listener.
func createServer(handler handlerFunc, port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveConn(conn, handler)
		}
	}()
	return ln, nil
}
