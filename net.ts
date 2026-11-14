// net.ts — a minimal HTTP/1.1 server over raw TCP (node:net).
// Replaces node:http: no request/response objects, no header object churn,
// one Buffer write per response. The suite drives it with fetch over
// keep-alive connections, so the parser handles many sequential requests per
// socket, Content-Length and chunked bodies, and Expect: 100-continue.
//
// Layout of this file, top to bottom:
//   1. request/response shapes and the status-text table
//   2. request parsing (request line, headers, chunked / length bodies)
//   3. response rendering (one Buffer per response)
//   4. per-connection state machine (the Connection class)
//   5. createServer (one Connection per accepted socket)
import net from 'node:net';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  host: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** When set, these exact bytes are written to the socket as-is (no rendering). */
  raw?: Buffer;
}

export type Handler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

interface Parsed {
  req: HttpRequest;
  consumed: number;
}

// ------------------------------------------------------------- 2. request parsing

/** Split "METHOD target HTTP/1.1" into its method and target. */
function parseRequestLine(line: string): { method: string; target: string } {
  const sp1 = line.indexOf(' ');
  const sp2 = line.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  return { method: line.slice(0, sp1), target: line.slice(sp1 + 1, sp2) };
}

/** Fold header lines into a lowercase-name -> value map. Lines without a
 *  colon are skipped (the original parser is lenient here). */
function parseHeaderLines(lines: string[]): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

type BodyRead =
  | { body: Buffer; consumed: number }
  | { sendContinue: true }
  | null;

/**
 * Read a chunked body starting at `bodyStart`: "<hex-size>\r\n<data>\r\n"
 * repeated, ending with a 0-size chunk and its trailer. Returns the joined
 * body plus the offset just past the trailer, null when more data is needed,
 * or sendContinue when the client is waiting on a 100-continue first.
 */
function readChunkedBody(buf: Buffer, bodyStart: number, expectContinue: boolean): BodyRead {
  let off = bodyStart;
  const chunks: Buffer[] = [];
  for (;;) {
    const eol = buf.indexOf('\r\n', off);
    if (eol < 0) {
      if (expectContinue) return { sendContinue: true };
      return null;
    }
    const sizeLine = buf.subarray(off, eol).toString('ascii').trim();
    const semi = sizeLine.indexOf(';');
    const size = parseInt(semi >= 0 ? sizeLine.slice(0, semi) : sizeLine, 16);
    if (Number.isNaN(size) || size < 0) throw new Error('bad chunk size');
    if (off + (eol - off) + 2 + size + 2 > buf.length) {
      if (expectContinue) return { sendContinue: true };
      return null;
    }
    off = eol + 2;
    if (size === 0) {
      // Trailer headers until an empty line.
      const trailerEnd = buf.indexOf('\r\n\r\n', off);
      const singleEnd = buf.indexOf('\r\n', off);
      const end = trailerEnd >= 0 ? trailerEnd + 4 : singleEnd + 2;
      if (end > buf.length) {
        if (expectContinue) return { sendContinue: true };
        return null;
      }
      return { body: Buffer.concat(chunks), consumed: end };
    }
    chunks.push(buf.subarray(off, off + size));
    off += size + 2; // skip data + trailing CRLF
  }
}

/**
 * Read a Content-Length body starting at `bodyStart`. A missing or
 * unparseable length means an empty body; a negative length is clamped to 0.
 */
function readLengthBody(buf: Buffer, bodyStart: number, headers: Map<string, string>, expectContinue: boolean): BodyRead {
  const contentLength = parseInt(headers.get('content-length') ?? '0', 10);
  const length = Number.isNaN(contentLength) ? 0 : Math.max(0, contentLength);
  if (buf.length < bodyStart + length) {
    if (expectContinue) return { sendContinue: true };
    return null;
  }
  const body = length === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(bodyStart, bodyStart + length));
  return { body, consumed: bodyStart + length };
}

/**
 * Try to parse one complete request from the front of `buf`.
 * Returns null when more data is needed. When headers are complete but the
 * body is not, and the client sent Expect: 100-continue, `sendContinue` is
 * true and the caller must answer `HTTP/1.1 100 Continue` before waiting.
 */
function tryParse(buf: Buffer): { parsed: Parsed } | { sendContinue: true } | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) return null;
  const headText = buf.subarray(0, headEnd).toString('latin1');
  const lines = headText.split('\r\n');
  const { method, target } = parseRequestLine(lines[0] ?? '');
  const headers = parseHeaderLines(lines.slice(1));
  const expect = (headers.get('expect') ?? '').toLowerCase();
  const expectContinue = expect === '100-continue';
  const bodyStart = headEnd + 4;
  const te = (headers.get('transfer-encoding') ?? '').toLowerCase();
  if (te.includes('chunked')) {
    const read = readChunkedBody(buf, bodyStart, expectContinue);
    if (read === null || 'sendContinue' in read) return read;
    const req = buildRequest(method, target, headers, read.body);
    return { parsed: { req, consumed: read.consumed } };
  }
  const read = readLengthBody(buf, bodyStart, headers, expectContinue);
  if (read === null || 'sendContinue' in read) return read;
  const req = buildRequest(method, target, headers, read.body);
  return { parsed: { req, consumed: read.consumed } };
}

/** Shared empty query params for requests without a query string: handlers
 *  only read via .get(), so one instance is safe to share. */
const EMPTY_QUERY = new URLSearchParams();

function buildRequest(method: string, target: string, headers: Map<string, string>, body: Buffer): HttpRequest {
  let path = target;
  // Fast paths: most requests carry no query string and no percent-escapes,
  // so skip the URLSearchParams allocation and the decodeURIComponent call.
  let query: URLSearchParams = EMPTY_QUERY;
  const q = target.indexOf('?');
  if (q >= 0) {
    path = target.slice(0, q);
    query = new URLSearchParams(target.slice(q + 1));
  }
  if (path.indexOf('%') >= 0) {
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  }
  return { method, path, query, headers, body, host: headers.get('host') ?? '127.0.0.1' };
}

// ------------------------------------------------------------- 3. response rendering

/** Build the full response bytes (head + body) in one Buffer. */
export function renderResponse(res: HttpResponse): Buffer {
  const text = STATUS_TEXT[res.status] ?? '';
  const parts: string[] = [`HTTP/1.1 ${res.status} ${text}\r\n`];
  for (const [k, v] of Object.entries(res.headers)) parts.push(`${k}: ${v}\r\n`);
  parts.push(`Connection: keep-alive\r\nContent-Length: ${res.body.length}\r\n\r\n`);
  const head = Buffer.from(parts.join(''), 'latin1');
  return res.body.length === 0 ? head : Buffer.concat([head, res.body]);
}

/** The 400 answer for a malformed request line or chunk size. */
function badRequestResponse(): HttpResponse {
  return {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: 'Bad Request' }), 'utf8'),
  };
}

/** The 500 answer when the application handler throws. */
function internalErrorResponse(): HttpResponse {
  return {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ message: 'internal error' }), 'utf8'),
  };
}

// ------------------------------------------------------------- 4. per-connection state machine

/**
 * One accepted socket and the bytes it has sent so far. `drain` walks the
 * buffer request by request (keep-alive: many sequential requests per
 * socket), running each through the handler and writing one response.
 * `continueSent` tracks whether the 100-continue interim reply went out for
 * the request currently being assembled; it resets once that request parses.
 */
class Connection {
  private buf = Buffer.alloc(0);
  private closed = false;
  private continueSent = false;
  private draining = false;
  private readonly socket: net.Socket;
  private readonly handler: Handler;

  constructor(socket: net.Socket, handler: Handler) {
    this.socket = socket;
    this.handler = handler;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
      void this.drain();
    });
    socket.on('error', () => { this.closed = true; });
    socket.on('close', () => { this.closed = true; });
  }

  /** Write one response, then honor `Connection: close` when asked. */
  private writeResponse(req: HttpRequest, res: HttpResponse): boolean {
    if (this.closed) return false;
    this.socket.write(res.raw ?? renderResponse(res));
    const conn = (req.headers.get('connection') ?? '').toLowerCase();
    if (conn === 'close') {
      this.socket.end();
      this.closed = true;
      return false;
    }
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.closed || this.buf.length === 0) return;
        let attempt: ReturnType<typeof tryParse>;
        try {
          attempt = tryParse(this.buf);
        } catch {
          // Malformed request line / chunk size: answer 400 and close.
          if (!this.closed) {
            this.socket.write(renderResponse(badRequestResponse()));
            this.socket.end();
          }
          this.closed = true;
          return;
        }
        if (attempt === null) return; // need more data
        if ('sendContinue' in attempt) {
          if (!this.continueSent) {
            this.continueSent = true;
            this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          return; // wait for the body to arrive
        }
        const { req, consumed } = attempt.parsed;
        this.buf = this.buf.subarray(consumed);
        this.continueSent = false;
        // Run the handler inline. When it is synchronous (the normal case
        // here) the request is handled and the response written in the same
        // tick, with no microtask hop from awaiting an async wrapper.
        let res: HttpResponse;
        try {
          const r = this.handler(req);
          res = r instanceof Promise ? await r : r;
        } catch (err) {
          process.stderr.write(`[net] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
          res = internalErrorResponse();
        }
        if (!this.writeResponse(req, res)) return;
      }
    } finally {
      this.draining = false;
    }
  }
}

// ------------------------------------------------------------- 5. createServer

export function createServer(handler: Handler): net.Server {
  return net.createServer((socket) => {
    new Connection(socket, handler);
  });
}
