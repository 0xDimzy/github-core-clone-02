// net.ts — a minimal HTTP/1.1 server over raw TCP (node:net).
// Replaces node:http: no request/response objects, no header object churn,
// one Buffer write per response. The suite drives it with fetch over
// keep-alive connections, so the parser handles many sequential requests per
// socket, Content-Length and chunked bodies, and Expect: 100-continue.
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
  const requestLine = lines[0] ?? '';
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const expect = (headers.get('expect') ?? '').toLowerCase();
  const bodyStart = headEnd + 4;
  const te = (headers.get('transfer-encoding') ?? '').toLowerCase();
  if (te.includes('chunked')) {
    // Parse chunked body: <hex-size>\r\n<data>\r\n ... 0\r\n\r\n
    let off = bodyStart;
    const chunks: Buffer[] = [];
    for (;;) {
      const eol = buf.indexOf('\r\n', off);
      if (eol < 0) {
        if (expect === '100-continue') return { sendContinue: true };
        return null;
      }
      const sizeLine = buf.subarray(off, eol).toString('ascii').trim();
      const semi = sizeLine.indexOf(';');
      const size = parseInt(semi >= 0 ? sizeLine.slice(0, semi) : sizeLine, 16);
      if (Number.isNaN(size) || size < 0) throw new Error('bad chunk size');
      if (off + (eol - off) + 2 + size + 2 > buf.length) {
        if (expect === '100-continue') return { sendContinue: true };
        return null;
      }
      off = eol + 2;
      if (size === 0) {
        // Trailer headers until an empty line.
        const trailerEnd = buf.indexOf('\r\n\r\n', off);
        const singleEnd = buf.indexOf('\r\n', off);
        const end = trailerEnd >= 0 ? trailerEnd + 4 : singleEnd + 2;
        if (end > buf.length) {
          if (expect === '100-continue') return { sendContinue: true };
          return null;
        }
        const req = buildRequest(method, target, headers, Buffer.concat(chunks));
        return { parsed: { req, consumed: end } };
      }
      chunks.push(buf.subarray(off, off + size));
      off += size + 2; // skip data + trailing CRLF
    }
  }
  const contentLength = parseInt(headers.get('content-length') ?? '0', 10);
  const length = Number.isNaN(contentLength) ? 0 : Math.max(0, contentLength);
  if (buf.length < bodyStart + length) {
    if (expect === '100-continue') return { sendContinue: true };
    return null;
  }
  const body = length === 0 ? Buffer.alloc(0) : Buffer.from(buf.subarray(bodyStart, bodyStart + length));
  const req = buildRequest(method, target, headers, body);
  return { parsed: { req, consumed: bodyStart + length } };
}

function buildRequest(method: string, target: string, headers: Map<string, string>, body: Buffer): HttpRequest {
  let path = target;
  let query = new URLSearchParams();
  const q = target.indexOf('?');
  if (q >= 0) {
    path = target.slice(0, q);
    query = new URLSearchParams(target.slice(q + 1));
  }
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  return { method, path, query, headers, body, host: headers.get('host') ?? '127.0.0.1' };
}

/** Build the full response bytes (head + body) in one Buffer. */
export function renderResponse(res: HttpResponse): Buffer {
  const text = STATUS_TEXT[res.status] ?? '';
  const parts: string[] = [`HTTP/1.1 ${res.status} ${text}\r\n`];
  for (const [k, v] of Object.entries(res.headers)) parts.push(`${k}: ${v}\r\n`);
  parts.push(`Connection: keep-alive\r\nContent-Length: ${res.body.length}\r\n\r\n`);
  const head = Buffer.from(parts.join(''), 'latin1');
  return res.body.length === 0 ? head : Buffer.concat([head, res.body]);
}

export function createServer(handler: Handler): net.Server {
  return net.createServer((socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let closed = false;
    let continueSent = false;
    let draining = false;

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      void drain();
    });
    socket.on('error', () => { closed = true; });
    socket.on('close', () => { closed = true; });

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        for (;;) {
          if (closed || buf.length === 0) return;
          let attempt: ReturnType<typeof tryParse>;
          try {
            attempt = tryParse(buf);
          } catch {
            // Malformed request line / chunk size: answer 400 and close.
            if (!closed) {
              socket.write(renderResponse({ status: 400, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ message: 'Bad Request' }), 'utf8') }));
              socket.end();
            }
            closed = true;
            return;
          }
          if (attempt === null) return; // need more data
          if ('sendContinue' in attempt) {
            if (!continueSent) {
              continueSent = true;
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            }
            return; // wait for the body to arrive
          }
          const { req, consumed } = attempt.parsed;
          buf = buf.subarray(consumed);
          continueSent = false;
          let res: HttpResponse;
          try {
            const r = handler(req);
            res = r instanceof Promise ? await r : r;
          } catch (err) {
            process.stderr.write(`[net] handler error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
            res = { status: 500, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ message: 'internal error' }), 'utf8') };
          }
          if (closed) return;
          socket.write(res.raw ?? renderResponse(res));
          const conn = (req.headers.get('connection') ?? '').toLowerCase();
          if (conn === 'close') { socket.end(); closed = true; return; }
        }
      } finally {
        draining = false;
      }
    }
  });
}
