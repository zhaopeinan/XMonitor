import net from 'node:net';
import tls from 'node:tls';

/** TLS 握手超时：内网握手通常几百毫秒，超过这个时长基本是被防火墙丢包 */
const TLS_TIMEOUT_MS = 4000;
/** 80 端口 HTTP 探测超时：只用来判断「是不是纯 HTTP 服务」，不用等太久 */
const HTTP_TIMEOUT_MS = 3000;
/** 最多读多少字节的 HTTP 响应，够解析状态行和头部即可 */
const HTTP_MAX_BYTES = 8192;

/** 一次 HTTPS 探测要连的目标：优先域名（SNI 正确才能拿到真正的证书），失败时回退 IP */
export interface HttpsTarget {
  /** 要连接的主机（域名或 IP 字面量） */
  host: string;
  port: number;
  /** TLS SNI 与证书对应的名字；没有域名时为 null */
  servername: string | null;
  /** 展示用文本，例如 example.com:443 */
  label: string;
}

/** 证书里的关键信息，全部来自 TLS 握手，不需要登录目标机器 */
export interface CertInfo {
  /** 证书主体（优先 CN），例如 *.example.com */
  subject: string;
  /** 颁发者（优先 CN），例如 R11 */
  issuer: string;
  /** 生效时间（毫秒时间戳） */
  validFrom: number | null;
  /** 过期时间（毫秒时间戳） */
  validTo: number | null;
  /** 距离过期还有多少天（负数表示已过期） */
  daysLeft: number | null;
  /** SAN 里的备用名称，例如 ["DNS:example.com", "IP Address:10.0.0.1"] */
  altNames: string[];
  /** 是否通过系统信任链验证：自签名、过期、名字不匹配都会是 false */
  authorized: boolean;
  /** 验证不通过的原因，例如 DEPTH_ZERO_SELF_SIGNED_CERT */
  authError: string | null;
  /** 握手用的 TLS 版本，例如 TLSv1.3 */
  protocol: string | null;
  fingerprint256: string;
  /** 是否疑似自签名（验证错误指向自签名，或主体与颁发者相同） */
  selfSigned: boolean;
}

export interface HttpsProbeOutcome {
  /** yes=握手成功（拿到证书）；no=明确没开 HTTPS；unknown=连不上或无法判定 */
  https: 'yes' | 'no' | 'unknown';
  /** 实际探测的目标文本 */
  target: string;
  cert: CertInfo | null;
  /** 逐条证据，写回台账时原文存档 */
  evidence: string[];
  /** 一句话说明（结论存在疑问时给出） */
  message: string | null;
  elapsedMs: number;
}

interface TlsAttempt {
  ok: boolean;
  peer: tls.PeerCertificate | null;
  protocol: string | null;
  authorized: boolean;
  authError: string | null;
  code: string | null;
  errorText: string | null;
}

interface HttpAttempt {
  ok: boolean;
  status: number | null;
  location: string | null;
  server: string | null;
  code: string | null;
  errorText: string | null;
}

/** 把证书里的时间字符串解析成毫秒时间戳：优先 Date.parse，兜底解析 OpenSSL 的 "Mar  1 00:00:00 2025 GMT" */
function parseCertTime(text: string | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return parsed;
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(trimmed);
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = months.indexOf(m[1].toLowerCase());
  if (month === -1) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** 证书里的主体 / 颁发者字段在 Node 里是对象：优先 CN，其次 O，最后拼成 k=v 列表 */
function displayName(field: unknown): string {
  if (!field || typeof field !== 'object') return '（未提供）';
  const record = field as Record<string, string>;
  const cn = record.CN ?? record.cn;
  if (cn) return cn;
  const o = record.O ?? record.o;
  if (o) return o;
  const entries = Object.entries(record);
  if (entries.length === 0) return '（未提供）';
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function parseAltNames(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function certFromPeer(
  peer: tls.PeerCertificate,
  protocol: string | null,
  authorized: boolean,
  authError: string | null,
): CertInfo | null {
  // 握手成功但拿不到证书（例如匿名套件）时保持空，不硬编一个假证书
  if (!peer || Object.keys(peer).length === 0 || !peer.valid_to) return null;
  const validFrom = parseCertTime(peer.valid_from);
  const validTo = parseCertTime(peer.valid_to);
  const subject = displayName(peer.subject);
  const issuer = displayName(peer.issuer);
  const daysLeft = validTo === null ? null : Math.floor((validTo - Date.now()) / 86_400_000);
  const authLower = (authError ?? '').toLowerCase();
  const selfSigned = authLower.includes('self_signed') || authLower.includes('depth_zero') || subject === issuer;
  return {
    subject,
    issuer,
    validFrom,
    validTo,
    daysLeft,
    altNames: parseAltNames(peer.subjectaltname),
    authorized,
    authError,
    protocol,
    fingerprint256: peer.fingerprint256 ?? '',
    selfSigned,
  };
}

/** 一次 TLS 握手：只连 443 完成握手、读证书，然后立刻断开 */
function tlsAttempt(host: string, port: number, servername: string | null): Promise<TlsAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket;
    const finish = (result: TlsAttempt) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // 已经断开
      }
      resolve(result);
    };
    const fail = (code: string | null, errorText: string | null) =>
      finish({ ok: false, peer: null, protocol: null, authorized: false, authError: null, code, errorText });

    socket = tls.connect({
      host,
      port,
      servername: servername ?? undefined,
      // 自签名 / 过期证书也要把证书拿回来：验证结果单独记录，不因为验证失败就放弃探测
      rejectUnauthorized: false,
    });
    socket.setTimeout(TLS_TIMEOUT_MS);
    socket.once('secureConnect', () => {
      finish({
        ok: true,
        peer: socket.getPeerCertificate(),
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        authError: socket.authorized ? null : String(socket.authorizationError ?? ''),
        code: null,
        errorText: null,
      });
    });
    socket.once('timeout', () => fail('ETIMEDOUT', `TLS 握手超时（${TLS_TIMEOUT_MS / 1000} 秒）`));
    socket.once('error', (err: NodeJS.ErrnoException) => fail(err.code ?? null, err.message));
  });
}

/** 一次 80 端口 HTTP 探测：只用来区分「纯 HTTP 服务」和「目标不可达」 */
function httpAttempt(host: string, port: number, hostHeader: string): Promise<HttpAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let socket: net.Socket;
    const finish = (result: HttpAttempt) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // 已经断开
      }
      resolve(result);
    };
    const fail = (code: string | null, errorText: string | null) =>
      finish({ ok: false, status: null, location: null, server: null, code, errorText });

    const parse = () => {
      const head = buffer.split('\r\n\r\n')[0];
      const lines = head.split('\r\n');
      const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? '');
      const header = (name: string): string | null => {
        const line = lines.find((item) => item.toLowerCase().startsWith(`${name}:`));
        return line ? line.slice(line.indexOf(':') + 1).trim() : null;
      };
      finish({
        ok: true,
        status: statusMatch ? Number(statusMatch[1]) : null,
        location: header('location'),
        server: header('server'),
        code: null,
        errorText: null,
      });
    };

    socket = net.connect({ host, port });
    socket.setTimeout(HTTP_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.write(
        `GET / HTTP/1.0\r\nHost: ${hostHeader}\r\nUser-Agent: XMonitor-HttpsProbe\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (buffer.includes('\r\n\r\n') || buffer.length >= HTTP_MAX_BYTES) parse();
    });
    socket.once('end', () => {
      // 服务端没发完整头部就断开：能解析多少算多少，一个字节都没有就算失败
      if (buffer.length > 0) parse();
      else fail(null, '80 端口连接被关闭，没有返回任何数据');
    });
    socket.once('timeout', () => fail('ETIMEDOUT', `HTTP 探测超时（${HTTP_TIMEOUT_MS / 1000} 秒）`));
    socket.once('error', (err: NodeJS.ErrnoException) => fail(err.code ?? null, err.message));
  });
}

/** 把握手失败翻译成一句人话，方便运维照单排查 */
function explainTlsError(attempt: TlsAttempt): string {
  switch (attempt.code) {
    case 'ECONNREFUSED':
      return '连接被拒绝：端口上没有服务监听';
    case 'ETIMEDOUT':
      return `连接超时（${TLS_TIMEOUT_MS / 1000} 秒）：目标不可达，或端口被防火墙静默丢弃`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '目标网络不可达';
    case 'ENOTFOUND':
      return '域名解析失败';
    case 'EPROTO':
      return '端口上不是 TLS 服务（可能是普通 HTTP 或其它协议）';
    case 'ECONNRESET':
      return '连接被重置（可能是防火墙拦截或服务中断）';
    default: {
      const text = (attempt.errorText ?? '').replace(/\s+/g, ' ').trim();
      // OpenSSL 的原始报错（ERR_SSL_*，例如 packet length too long）对运维没有可读性，
      // 这类错误基本都是「对面不是 TLS 服务」，统一翻译成人话
      if (/^ERR_SSL/i.test(attempt.code ?? '') || /SSL routines|packet length too long|wrong version number/i.test(text)) {
        return '端口上不是 TLS 服务（可能是普通 HTTP 或其它协议）';
      }
      return text || 'TLS 握手失败';
    }
  }
}

function formatKeepDays(daysLeft: number | null): string {
  if (daysLeft === null) return '剩余天数未知';
  if (daysLeft < 0) return `已过期 ${Math.abs(daysLeft)} 天`;
  return `剩 ${daysLeft} 天`;
}

/**
 * 探测一个台账条目的 HTTPS 与证书：
 * 1. 按顺序对候选目标做 TLS 握手（域名优先、IP 兜底），能握手就说明支持 HTTPS，并从证书里读有效期；
 * 2. 握手全部失败时，再看 80 端口是「纯 HTTP 服务」还是「根本连不上」，把「不支持」和「不可达」区分开。
 */
export async function probeHttpsTargets(targets: HttpsTarget[]): Promise<HttpsProbeOutcome> {
  const started = Date.now();
  const evidence: string[] = [];
  const elapsed = () => Date.now() - started;
  const primary = targets[0];

  for (const target of targets) {
    const attempt = await tlsAttempt(target.host, target.port, target.servername);
    if (attempt.ok) {
      const cert = certFromPeer(attempt.peer!, attempt.protocol, attempt.authorized, attempt.authError);
      evidence.push(`TLS 握手成功：${target.label}（${attempt.protocol ?? '协议版本未知'}）`);
      if (cert) {
        evidence.push(`证书主体：${cert.subject}`);
        evidence.push(`颁发者：${cert.issuer}`);
        if (cert.validFrom !== null && cert.validTo !== null) {
          evidence.push(`证书有效期：${new Date(cert.validFrom).toISOString()} → ${new Date(cert.validTo).toISOString()}（${formatKeepDays(cert.daysLeft)}）`);
        }
        if (cert.altNames.length > 0) evidence.push(`备用名称：${cert.altNames.join(', ')}`);
        evidence.push(
          cert.authorized
            ? '证书链验证：通过'
            : `证书链验证：未通过（${cert.authError ?? '未知原因'}${cert.selfSigned ? '，疑似自签名证书' : ''}）`,
        );
      } else {
        evidence.push('握手成功，但服务端没有下发证书');
      }
      const message = cert && !cert.authorized
        ? cert.selfSigned
          ? '证书是自签名（未通过系统信任链），内网服务器常见；有效期信息仍然可信'
          : '证书未通过系统信任链验证（可能已过期或名字对不上）；有效期信息仍然可信'
        : null;
      return { https: 'yes', target: target.label, cert, evidence, message, elapsedMs: elapsed() };
    }
    evidence.push(`${target.label} 的 TLS 握手失败：${explainTlsError(attempt)}`);
  }

  if (!primary) {
    return { https: 'unknown', target: '', cert: null, evidence, message: '没有可探测的目标', elapsedMs: elapsed() };
  }

  // 443 都不通：看 80 端口能不能提供 HTTP，用来区分「明确只开了 HTTP」和「目标整个连不上」
  const http = await httpAttempt(primary.host, 80, primary.servername ?? primary.host);
  if (http.ok) {
    evidence.push(
      `80 端口返回 HTTP ${http.status ?? '未知状态'}${http.server ? `（Server: ${http.server}）` : ''}`,
    );
    if (http.location && /^https:\/\//i.test(http.location)) {
      evidence.push(`80 端口要求跳转到 ${http.location}`);
      return {
        https: 'yes',
        target: primary.label,
        cert: null,
        evidence,
        message: '80 端口重定向到 HTTPS，但 TLS 握手没成功，这次没取到证书',
        elapsedMs: elapsed(),
      };
    }
    return {
      https: 'no',
      target: primary.label,
      cert: null,
      evidence,
      message: '只探测到 HTTP，443 端口没有可用的 HTTPS 服务',
      elapsedMs: elapsed(),
    };
  }
  evidence.push(
    `80 端口探测失败：${
      http.code === 'ETIMEDOUT'
        ? `连接超时（${HTTP_TIMEOUT_MS / 1000} 秒）`
        : (http.errorText ?? '连接失败').replace(/\s+/g, ' ').trim()
    }`,
  );
  return {
    https: 'unknown',
    target: primary.label,
    cert: null,
    evidence,
    message: '目标不可达或端口被防火墙拦截：TLS 和 80 端口都没有响应，这次没拿到结论',
    elapsedMs: elapsed(),
  };
}
