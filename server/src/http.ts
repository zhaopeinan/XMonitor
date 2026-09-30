import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

// 某些老系统会返回非法响应头（如 `Cache=Control: no-cache`，头名含 `=`），
// 严格解析器（undici fetch / hyper / llhttp，即使 insecureHTTPParser）都会整包拒收。
// 这里直接用裸 TCP/TLS socket 手写 HTTP/1.1 报文解析，对响应头完全宽容。

export interface LenientResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LenientRequestInit {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Buffer;
  timeoutMs?: number;
}

const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 判断浏览器导航错误是否为网络层失败（目标站协议不兼容、连接被拒等），可降级到宽松 HTTP */
export function isBrowserNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /Network error|net::|ERR_CONNECTION|ERR_TIMED_OUT|error sending request/i.test(msg);
}

function sanitizeHeaderName(name: string): string {
  if (VALID_HEADER_NAME.test(name)) return name;
  // 非法字符统一替换为 -（如 Cache=Control → Cache-Control）
  return name.replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, '-');
}

function buildHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    try {
      headers.append(sanitizeHeaderName(rawHeaders[i]), rawHeaders[i + 1]);
    } catch {
      // 单个头仍异常时跳过，不影响整体
    }
  }
  return headers;
}

function decompress(body: Buffer, encoding: string | null): Buffer {
  try {
    switch ((encoding ?? '').toLowerCase()) {
      case 'gzip':
        return zlib.gunzipSync(body);
      case 'deflate':
        return zlib.inflateSync(body);
      case 'br':
        return zlib.brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB 上限，防内存被打爆

/** 单次请求（不跟随重定向），裸 socket 手写解析，宽容处理非法响应头 */
export function lenientRequest(url: string, init: LenientRequestInit = {}): Promise<LenientResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`非法 URL: ${url}`));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`不支持的协议: ${u.protocol}`));
      return;
    }
    const isTls = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : isTls ? 443 : 80;
    const path = (u.pathname || '/') + u.search;
    const method = (init.method ?? 'GET').toUpperCase();

    const headers: Record<string, string> = {};
    if (init.headers) {
      const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers['Host'] = u.host;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = 'XMonitor/1.0';
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
      headers['Accept-Encoding'] = 'gzip, deflate, br';
    }
    headers['Connection'] = 'close';

    const bodyBuf = init.body === undefined ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body);
    if (bodyBuf && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(bodyBuf.byteLength);
    }

    const sock = isTls
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const done = (res: LenientResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(res);
    };
    const timer = setTimeout(() => fail(new Error(`请求超时（${init.timeoutMs ?? 15_000}ms）`)), init.timeoutMs ?? 15_000);

    let buf = Buffer.alloc(0);
    let headParsed = false;
    let status = 0;
    let rawHeaders: string[] = [];
    let chunked = false;
    let contentLength = -1;
    const bodyChunks: Buffer[] = [];
    let bodyLen = 0;

    const finish = () => {
      const headers = buildHeaders(rawHeaders);
      const raw = Buffer.concat(bodyChunks, bodyLen);
      const body = decompress(raw, headers.get('content-encoding'));
      done({
        status,
        headers,
        body,
        async text() {
          return body.toString('utf-8');
        },
        async arrayBuffer() {
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
        },
      });
    };

    const parseHead = (): boolean => {
      // 可能有 1xx（如 100 Continue）占位头块，循环跳过
      for (;;) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return false;
        const headText = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 4);
        const lines = headText.split('\r\n');
        const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(lines[0] ?? '');
        if (!m) {
          fail(new Error(`无法解析响应状态行: ${(lines[0] ?? '').slice(0, 80)}`));
          return false;
        }
        status = Number(m[1]);
        if (status >= 100 && status < 200 && status !== 101) continue; // 信息性响应，继续读下一块
        rawHeaders = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const colon = line.indexOf(':');
          if (colon <= 0) continue; // 无冒号的行直接忽略
          rawHeaders.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        const headers = buildHeaders(rawHeaders);
        const te = headers.get('transfer-encoding') ?? '';
        chunked = /chunked/i.test(te);
        const cl = headers.get('content-length');
        contentLength = cl !== null && /^\d+$/.test(cl) ? Number(cl) : -1;
        headParsed = true;
        return true;
      }
    };

    const process_ = () => {
      if (settled) return;
      if (!headParsed && !parseHead()) return;
      if (chunked) {
        for (;;) {
          const lineEnd = buf.indexOf('\r\n');
          if (lineEnd < 0) return;
          const sizeHex = buf.subarray(0, lineEnd).toString('latin1').split(';')[0].trim();
          const size = parseInt(sizeHex, 16);
          if (Number.isNaN(size)) {
            // 块大小行损坏：保守起见到此为止，已收到的数据照常返回
            finish();
            return;
          }
          if (size === 0) {
            finish();
            return;
          }
          if (buf.length < lineEnd + 2 + size) return; // 数据未到齐
          bodyChunks.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
          bodyLen += size;
          buf = buf.subarray(lineEnd + 2 + size + 2); // 跳过块尾 CRLF
          if (bodyLen > MAX_BODY_BYTES) {
            fail(new Error('响应体超过 32MB 上限'));
            return;
          }
        }
      } else if (contentLength >= 0) {
        if (buf.length < contentLength) return;
        bodyChunks.push(buf.subarray(0, contentLength));
        bodyLen = contentLength;
        finish();
      }
      // 无 Content-Length 且非 chunked：等连接关闭（Connection: close 保证会关）
    };

    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      process_();
    });
    sock.on('close', () => {
      if (settled) return;
      if (!headParsed) {
        fail(new Error('连接被关闭，未收到完整响应头'));
        return;
      }
      // 连接关闭即报文结束（无 Content-Length 的场景）
      if (buf.length > 0) {
        bodyChunks.push(buf);
        bodyLen += buf.length;
        buf = Buffer.alloc(0);
      }
      finish();
    });
    sock.on('error', (err) => {
      if (settled) return;
      // 已拿到完整响应后对方的 RST 不影响结果
      if (headParsed && (chunked || contentLength >= 0)) {
        if (buf.length > 0) {
          bodyChunks.push(buf);
          bodyLen += buf.length;
        }
        finish();
        return;
      }
      fail(err);
    });

    sock.once(isTls ? 'secureConnect' : 'connect', () => {
      const head =
        `${method} ${path} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('') +
        '\r\n';
      sock.write(head);
      if (bodyBuf) sock.write(bodyBuf);
    });
  });
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 跟随重定向的宽松请求（类似 fetch 的 redirect: 'follow'） */
export async function lenientFetch(url: string, init: LenientRequestInit = {}, maxRedirects = 5): Promise<LenientResponse> {
  let current = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  for (let i = 0; ; i++) {
    const res = await lenientRequest(current, { ...init, method, body });
    if (!REDIRECT_STATUS.has(res.status) || i >= maxRedirects) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    current = new URL(location, current).href;
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      // 浏览器惯例：301/302/303 后转为 GET
      method = 'GET';
      body = undefined;
    }
  }
}
