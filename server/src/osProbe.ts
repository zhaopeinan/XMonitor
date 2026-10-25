import { Socket, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';

/**
 * 操作系统探测：只用「TCP 端口 + 服务横幅」这一档。
 *
 * 纯 TCP 连接读几个字节，不需要原始套接字、不需要 root、也不用装 nmap，
 * 容器里现成能跑。能读到发行版的场景（SSH 横幅、HTTP Server 头）结论比较硬，
 * 只有端口组合的场景只会给出「疑似」，避免把特征推断说成登记事实。
 */

/** 系统族：Linux/Unix、Windows、网络设备 */
export type OsFamily = 'linux' | 'windows' | 'network';

export interface OsEvidence {
  port: number;
  /** 证据来源，例如「SSH 横幅」「HTTP Server 头」「SMB2 应答」 */
  source: string;
  /** 抓到的原文（去掉控制字符并截断） */
  detail: string;
  /** 这条证据指向的系统族 */
  family: OsFamily;
  /** 从证据里读出的系统名，例如 Ubuntu / IIS 10.0 / Cisco IOS */
  version: string | null;
  /** 证据里明确写了系统名（而不是「这个端口通常属于 Windows」这类的推断） */
  strong: boolean;
  /** Windows 典型服务信号：多个信号同时命中才敢下结论 */
  windowsService: boolean;
  /** Windows 专属服务（远程桌面/SMB 有应答、WinRM 等），多个命中就不再叫「疑似」 */
  windowsDedicated: boolean;
  /** 展示给用户的一句话说明 */
  note: string;
}

export interface OsProbeOutcome {
  /** 探测目标（IP） */
  ip: string;
  /** 目标上开放（或是已知服务端口有应答）的端口，升序 */
  openPorts: number[];
  evidence: OsEvidence[];
  /** 结论：Linux（Ubuntu）/ Windows（疑似）/ 网络设备（Cisco IOS）；证据不足时为空串 */
  os: string;
  /** 证据不足、目标不可达时的说明 */
  message: string | null;
}

/** TCP 连接超时：内网 400ms 够用，超了当端口关闭或被防火墙拦掉 */
const CONNECT_TIMEOUT_MS = 400;
/** 连上后等服务端先开口的时间（SSH / Telnet / FTP 这类协议） */
const BANNER_WAIT_MS = 700;
/** 主动发探测包后等应答的时间（HTTP / SMB / RDP） */
const REPLY_WAIT_MS = 800;
/** 单条原文最多保留多少字符（存库、展示都要短） */
const MAX_DETAIL = 160;

/** 探哪些端口：服务端先开口的 / 要发探测包的 / 只看开没开的 */
const BANNER_PORTS = [21, 22, 23];
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const SMB_PORT = 445;
const RDP_PORT = 3389;
const PLAIN_PORTS = [135, 139, 5985, 5986];

/** 只看端口开着就有意义的端口：这台机器上这些服务基本都是 Windows 自带 */
const PLAIN_PORT_HINTS: Record<number, { label: string; note: string }> = {
  135: { label: 'MSRPC 端点映射', note: 'Windows 自带的 RPC 端点映射端口' },
  139: { label: 'NetBIOS 会话服务', note: 'Windows 文件共享的 NetBIOS 端口' },
  5985: { label: 'WinRM 明文', note: 'Windows 远程管理端口，基本只有 Windows 会开' },
  5986: { label: 'WinRM over TLS', note: 'Windows 远程管理端口，基本只有 Windows 会开' },
};

/** 横幅里能直接读出来的系统名（SSH / Telnet / FTP 共用）；Windows 的写法不带「Windows」前缀，结论里由 formatOs 统一加 */
const BANNER_SYSTEMS: { re: RegExp; name: string; family: OsFamily; windowsService?: boolean }[] = [
  { re: /OpenSSH_for_Windows/i, name: '内置 OpenSSH', family: 'windows', windowsService: true },
  { re: /Microsoft FTP Service/i, name: 'Microsoft FTP', family: 'windows', windowsService: true },
  { re: /Ubuntu/i, name: 'Ubuntu', family: 'linux' },
  { re: /Debian/i, name: 'Debian', family: 'linux' },
  { re: /CentOS/i, name: 'CentOS', family: 'linux' },
  { re: /Red ?Hat|RHEL/i, name: 'Red Hat', family: 'linux' },
  { re: /Rocky/i, name: 'Rocky Linux', family: 'linux' },
  { re: /Alma(?:Linux)?/i, name: 'AlmaLinux', family: 'linux' },
  { re: /openSUSE|SUSE|SLES/i, name: 'SUSE', family: 'linux' },
  { re: /Fedora/i, name: 'Fedora', family: 'linux' },
  { re: /Amazon Linux/i, name: 'Amazon Linux', family: 'linux' },
  { re: /FreeBSD/i, name: 'FreeBSD', family: 'linux' },
  { re: /OpenBSD/i, name: 'OpenBSD', family: 'linux' },
  { re: /NetBSD/i, name: 'NetBSD', family: 'linux' },
  { re: /\bAIX\b/i, name: 'AIX', family: 'linux' },
  { re: /Solaris|SunOS/i, name: 'Solaris', family: 'linux' },
  { re: /User Access Verification/i, name: 'Cisco IOS', family: 'network' },
  { re: /Cisco/i, name: 'Cisco IOS', family: 'network' },
  { re: /RouterOS/i, name: 'MikroTik RouterOS', family: 'network' },
  { re: /Forti(?:net|OS)/i, name: 'FortiOS', family: 'network' },
  { re: /Huawei|VRP/i, name: 'Huawei VRP', family: 'network' },
  { re: /H3C|Comware/i, name: 'H3C Comware', family: 'network' },
  { re: /Juniper|JUNOS/i, name: 'Junos', family: 'network' },
  { re: /RomSShell/i, name: '网络设备（RomSShell）', family: 'network' },
];

/** BSD / 商业 Unix：结论里说「Unix」比说「Linux」准确 */
const UNIX_FLAVORS = new Set(['FreeBSD', 'OpenBSD', 'NetBSD', 'AIX', 'Solaris']);

/** 不带系统名的通用 Web 服务器：只能弱弱地偏向 Linux */
const GENERIC_WEB_SERVERS = /nginx|apache|openresty|jetty|tomcat|gunicorn|uvicorn|werkzeug|lighttpd|tengine|caddy|kestrel/i;

/** IIS 版本对应的 Windows 版本，写进证据里给用户参考 */
const IIS_HINTS: Record<string, string> = {
  '10.0': 'Server 2016 / 2019 / 2022',
  '8.5': 'Server 2012 R2',
  '8.0': 'Server 2012',
  '7.5': 'Server 2008 R2',
  '6.0': 'Server 2003',
};

/** 结论里至少要攒到这个分才敢给一个系统族 */
const MIN_SCORE = 3;

interface RawProbe {
  open: boolean;
  data: Buffer;
  error: string | null;
}

/** 去掉控制字符、压缩空白并截断，方便存库和展示 */
function cleanText(raw: string, max = MAX_DETAIL): string {
  const text = raw.replace(/[^\x20-\x7e\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 一次 TCP 探测：连上、可选地发一段数据、按需等应答 */
function rawProbe(
  host: string,
  port: number,
  options: { send?: Buffer; waitMs: number; settle?: (buf: Buffer) => boolean },
): Promise<RawProbe> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let data = Buffer.alloc(0);
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const done = (result: RawProbe) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    // 只用这一个定时器：连上前是连接超时，连上后换成等应答的时间窗。
    // 不能用 socket.setTimeout——那是空闲超时，服务端先开口的协议会被它提前掐断。
    timer = setTimeout(() => done({ open: false, data: Buffer.alloc(0), error: 'ETIMEOUT' }), CONNECT_TIMEOUT_MS);

    socket.on('error', (err) =>
      done({ open: false, data: Buffer.alloc(0), error: (err as NodeJS.ErrnoException).code ?? 'ERR' }),
    );
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (options.settle?.(data)) done({ open: true, data, error: null });
    });
    socket.on('connect', () => {
      if (timer) clearTimeout(timer);
      if (options.send) socket.write(options.send);
      // waitMs=0 表示只确认端口开着，不等对端说话
      if (options.waitMs <= 0) done({ open: true, data, error: null });
      else timer = setTimeout(() => done({ open: true, data, error: null }), options.waitMs);
    });
    socket.connect({ host, port });
  });
}

/** HTTPS 探测：TLS 握手后发一次 HTTP 请求，握手失败按「端口开着但读不到」处理 */
function tlsProbe(host: string, port: number, request: string): Promise<RawProbe> {
  return new Promise((resolve) => {
    const options: ConnectionOptions = {
      host,
      port,
      rejectUnauthorized: false,
    };
    // servername 只认主机名，目标是 IP 时不带 SNI
    if (isIP(host) === 0) options.servername = host;

    let data = Buffer.alloc(0);
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let socket: TLSSocket;

    const done = (result: RawProbe) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    // 同样只用显式定时器：握手给一个连接超时，握手成功后换成等应答的时间窗
    timer = setTimeout(() => done({ open: false, data: Buffer.alloc(0), error: 'ETIMEOUT' }), CONNECT_TIMEOUT_MS);

    try {
      socket = tlsConnect(options, () => {
        if (timer) clearTimeout(timer);
        socket.write(request);
        timer = setTimeout(() => done({ open: true, data, error: null }), REPLY_WAIT_MS);
      });
    } catch {
      if (timer) clearTimeout(timer);
      resolve({ open: false, data: Buffer.alloc(0), error: 'ETLS' });
      return;
    }

    socket.on('error', (err) =>
      done({ open: false, data: Buffer.alloc(0), error: (err as NodeJS.ErrnoException).code ?? 'ERR' }),
    );
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.includes('\r\n\r\n') || data.length > 4096) done({ open: true, data, error: null });
    });
  });
}

function httpRequest(hostHeader: string | null): string {
  return [
    'GET / HTTP/1.0',
    hostHeader ? `Host: ${hostHeader}` : null,
    'User-Agent: XMonitor-OS-Probe',
    'Accept: */*',
    'Connection: close',
    '',
    '',
  ]
    .filter((line) => line !== null)
    .join('\r\n');
}

/** SMB2 NEGOTIATE 请求：只要拿到应答就说明这台机器在跑 SMB 服务 */
function smbNegotiateRequest(): Buffer {
  const dialects = [0x0202, 0x0210, 0x0300, 0x0302, 0x0311];
  const body = Buffer.alloc(36 + dialects.length * 2);
  body.writeUInt16LE(36, 0); // StructureSize
  body.writeUInt16LE(dialects.length, 2); // DialectCount
  body.writeUInt16LE(0x0001, 4); // SecurityMode：开启签名
  body.writeUInt32LE(0, 8); // Capabilities
  dialects.forEach((dialect, i) => body.writeUInt16LE(dialect, 36 + i * 2));

  const header = Buffer.alloc(64);
  header[0] = 0xfe; // SMB2 协议标识
  header[1] = 0x53;
  header[2] = 0x4d;
  header[3] = 0x42;
  header.writeUInt16LE(64, 4); // StructureSize
  header.writeUInt16LE(0, 12); // Command = NEGOTIATE
  header.writeUInt16LE(1, 14); // CreditRequest

  const message = Buffer.concat([header, body]);
  const netbios = Buffer.alloc(4);
  netbios.writeUInt8(0, 0); // 会话消息
  netbios.writeUIntBE(message.length, 1, 3);
  return Buffer.concat([netbios, message]);
}

/** RDP 连接请求：标准 X.224 协商包，能收到 Connection Confirm 就说明 3389 在跑 RDP */
function rdpConnectionRequest(): Buffer {
  return Buffer.from([
    0x03, 0x00, 0x00, 0x13, // TPKT，长度 19
    0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 Connection Request
    0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, // RDP Negotiation Request
  ]);
}

function isSmbResponse(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return (
    (buf[4] === 0xfe && buf[5] === 0x53 && buf[6] === 0x4d && buf[7] === 0x42) ||
    (buf[4] === 0xff && buf[5] === 0x53 && buf[6] === 0x4d && buf[7] === 0x42)
  );
}

function isRdpResponse(buf: Buffer): boolean {
  return buf.length >= 6 && buf[0] === 0x03 && buf[1] === 0x00 && buf[5] === 0xd0;
}

function smbDialectName(dialect: number): string {
  if (dialect === 0x0202) return 'SMB 2.0.2';
  if (dialect === 0x0210) return 'SMB 2.1';
  if (dialect === 0x0300) return 'SMB 3.0';
  if (dialect === 0x0302) return 'SMB 3.0.2';
  if (dialect === 0x0311) return 'SMB 3.1.1';
  return 'SMB';
}

/** 从 SSH / Telnet / FTP 横幅里认出系统；认不出明确的发行版时返回通用结论 */
function evidenceFromBanner(port: number, source: string, banner: string): OsEvidence | null {
  const text = cleanText(banner);
  if (!text) return null;

  for (const item of BANNER_SYSTEMS) {
    if (item.re.test(text)) {
      return {
        port,
        source,
        detail: text,
        family: item.family,
        version: item.name,
        strong: true,
        windowsService: item.windowsService === true,
        windowsDedicated: item.windowsService === true,
        note: `横幅里写着 ${item.name}`,
      };
    }
  }

  // OpenSSH / Dropbear 没有发行版后缀：只能说明是 Unix 系的 SSH 服务
  if (/OpenSSH|Dropbear/i.test(text)) {
    return {
      port,
      source,
      detail: text,
      family: 'linux',
      version: null,
      strong: false,
      windowsService: false,
      windowsDedicated: false,
      note: 'SSH 服务（OpenSSH/Dropbear 常见于 Linux/Unix，横幅里没写发行版）',
    };
  }
  return {
    port,
    source,
    detail: text,
    family: 'linux',
    version: null,
    strong: false,
    windowsService: false,
    windowsDedicated: false,
    note: '有服务横幅但读不出系统名',
  };
}

/** HTTP 响应头里的系统线索：Server / X-Powered-By */
function evidenceFromHttp(port: number, text: string): OsEvidence[] {
  const out: OsEvidence[] = [];
  const headerBlock = text.split('\r\n\r\n')[0] ?? text;
  const server = /^server:\s*(.+)$/im.exec(headerBlock)?.[1]?.trim() ?? '';
  const poweredBy = /^x-powered-by:\s*(.+)$/im.exec(headerBlock)?.[1]?.trim() ?? '';
  const aspNet = /^x-aspnet-version:\s*(.+)$/im.exec(headerBlock)?.[1]?.trim() ?? '';
  const status = /^HTTP\/[\d.]+\s+(\d{3})/i.exec(headerBlock)?.[1] ?? '';

  if (server) {
    const detail = cleanText(`Server: ${server}${status ? `（HTTP ${status}）` : ''}`);
    if (/microsoft-iis/i.test(server) || /microsoft-httpapi/i.test(server)) {
      const version = /microsoft-iis\/([\d.]+)/i.exec(server)?.[1] ?? '';
      const iis = version ? `IIS ${version}` : 'Microsoft HTTPAPI';
      const guess = version ? IIS_HINTS[version] : undefined;
      out.push({
        port,
        source: 'HTTP Server 头',
        detail,
        family: 'windows',
        version: iis,
        strong: true,
        windowsService: true,
        windowsDedicated: true,
        note: `IIS 是 Windows 自带组件${guess ? `，该版本常见于 ${guess}` : ''}`,
      });
      return out;
    }
    const hit = BANNER_SYSTEMS.find((item) => item.re.test(server));
    if (hit) {
      out.push({
        port,
        source: 'HTTP Server 头',
        detail,
        family: hit.family,
        version: hit.name,
        strong: true,
        windowsService: hit.windowsService === true,
        windowsDedicated: hit.windowsService === true,
        note: `Server 头里带着发行版 ${hit.name}`,
      });
      return out;
    }
    if (GENERIC_WEB_SERVERS.test(server)) {
      out.push({
        port,
        source: 'HTTP Server 头',
        detail,
        family: 'linux',
        version: null,
        strong: false,
        windowsService: false,
        windowsDedicated: false,
        note: 'Web 服务（这类服务器常见于 Linux，但没有发行版信息）',
      });
    }
  }

  if (/asp\.net/i.test(poweredBy) || aspNet) {
    out.push({
      port,
      source: 'HTTP 响应头',
      detail: cleanText(`X-Powered-By: ${poweredBy || 'ASP.NET'}${aspNet ? ` / X-AspNet-Version: ${aspNet}` : ''}`),
      family: 'windows',
      version: 'ASP.NET',
      strong: false,
      windowsService: true,
      windowsDedicated: true,
      note: 'ASP.NET 通常跑在 Windows + IIS 上',
    });
  }
  return out;
}

/** 80 和 443 常常是同一套服务：同一条证据只留一份，避免重复计分 */
function pushEvidence(list: OsEvidence[], items: OsEvidence[]): void {
  for (const item of items) {
    if (list.some((exist) => exist.source === item.source && exist.detail === item.detail)) continue;
    list.push(item);
  }
}

function formatOs(family: OsFamily, version: string | null, confident: boolean): string {
  if (family === 'linux') {
    if (version) {
      const label = UNIX_FLAVORS.has(version) ? 'Unix' : 'Linux';
      return `${label}（${version}）`;
    }
    return 'Linux（疑似）';
  }
  if (family === 'windows') {
    if (version) return `Windows（${version}）`;
    return confident ? 'Windows' : 'Windows（疑似）';
  }
  if (version) return `网络设备（${version}）`;
  return '网络设备（疑似）';
}

/** 探测一个 IP：并行跑完所有端口，再按证据打分给出结论 */
export async function probeHostOs(host: string, httpHost?: string | null): Promise<OsProbeOutcome> {
  const request = Buffer.from(httpRequest(httpHost && httpHost.trim() ? httpHost.trim() : null), 'utf8');

  const [bannerResults, httpResult, httpsResult, smbResult, rdpResult, plainResults] = await Promise.all([
    Promise.all(BANNER_PORTS.map((port) => rawProbe(host, port, { waitMs: BANNER_WAIT_MS }))),
    rawProbe(host, HTTP_PORT, { send: request, waitMs: REPLY_WAIT_MS, settle: (b) => b.includes('\r\n\r\n') }),
    tlsProbe(host, HTTPS_PORT, request.toString('utf8')),
    rawProbe(host, SMB_PORT, { send: smbNegotiateRequest(), waitMs: REPLY_WAIT_MS, settle: isSmbResponse }),
    rawProbe(host, RDP_PORT, { send: rdpConnectionRequest(), waitMs: REPLY_WAIT_MS, settle: isRdpResponse }),
    Promise.all(PLAIN_PORTS.map((port) => rawProbe(host, port, { waitMs: 0 }))),
  ]);

  const evidence: OsEvidence[] = [];
  const openPorts = new Set<number>();

  BANNER_PORTS.forEach((port, index) => {
    const result = bannerResults[index];
    if (!result.open) return;
    openPorts.add(port);
    const banner = result.data.toString('utf8');
    if (!banner.trim()) return;
    const label = port === 22 ? 'SSH 横幅' : port === 23 ? 'Telnet 横幅' : 'FTP 横幅';
    const hit = evidenceFromBanner(port, label, banner);
    if (hit) evidence.push(hit);
  });

  if (httpResult.open) {
    openPorts.add(HTTP_PORT);
    pushEvidence(evidence, evidenceFromHttp(HTTP_PORT, httpResult.data.toString('utf8')));
  }

  // TLS 握手失败不代表 443 关着：可能上面跑的是明文 HTTP 或别的协议。
  // 这时补一次裸探测确认端口状态，顺手把明文响应也按 HTTP 解析一遍。
  const httpsPlain =
    httpsResult.open
      ? null
      : await rawProbe(host, HTTPS_PORT, {
          send: request,
          waitMs: REPLY_WAIT_MS,
          settle: (b) => b.includes('\r\n\r\n'),
        });
  const httpsData = httpsResult.open ? httpsResult.data : httpsPlain?.open ? httpsPlain.data : null;

  if (httpsData !== null) {
    openPorts.add(HTTPS_PORT);
    pushEvidence(evidence, evidenceFromHttp(HTTPS_PORT, httpsData.toString('utf8')));
  }

  if (smbResult.open) {
    openPorts.add(SMB_PORT);
    if (isSmbResponse(smbResult.data)) {
      const smb2 = smbResult.data[4] === 0xfe;
      const dialect = smb2 && smbResult.data.length >= 74 ? smbResult.data.readUInt16LE(72) : 0;
      const dialectName = smb2 ? smbDialectName(dialect) : 'SMB 1';
      evidence.push({
        port: SMB_PORT,
        source: `${smb2 ? 'SMB2' : 'SMB1'} 应答`,
        detail: smb2 ? `协商到 ${dialectName}` : 'SMB1 NEGOTIATE 应答',
        family: 'windows',
        version: null,
        strong: false,
        windowsService: true,
        // 有 SMB 协商应答才说明这台机器确实在跑 SMB 服务，不只是端口开着
        windowsDedicated: true,
        note: smb2
          ? 'SMB2 是 Windows 文件共享协议，也可能是 Linux 上的 Samba'
          : 'SMB1 应答：老版本 Windows 或 Samba 兼容模式',
      });
    } else {
      evidence.push({
        port: SMB_PORT,
        source: '端口开放',
        detail: '端口开了但没收到 SMB 协商应答',
        family: 'windows',
        version: null,
        strong: false,
        windowsService: true,
        windowsDedicated: false,
        note: '445 是 Windows 文件共享常用端口',
      });
    }
  }

  if (rdpResult.open) {
    openPorts.add(RDP_PORT);
    const confirmed = isRdpResponse(rdpResult.data);
    evidence.push({
      port: RDP_PORT,
      source: confirmed ? 'RDP 应答' : '端口开放',
      detail: confirmed ? 'X.224 Connection Confirm（远程桌面协议应答）' : '端口开了但没收到 RDP 协商应答',
      family: 'windows',
      version: null,
      strong: false,
      windowsService: true,
      windowsDedicated: confirmed,
      note: '远程桌面通常是 Windows 自带，Linux 上的 xrdp 也会开这个端口',
    });
  }

  PLAIN_PORTS.forEach((port, index) => {
    if (!plainResults[index].open) return;
    openPorts.add(port);
    const hint = PLAIN_PORT_HINTS[port];
    evidence.push({
      port,
      source: `端口开放${hint ? `（${hint.label}）` : ''}`,
      detail: '',
      family: 'windows',
      version: null,
      strong: false,
      windowsService: true,
      // WinRM 基本只有 Windows 会开；135/139 只算「常见」，防火墙或转发也能开
      windowsDedicated: port === 5985 || port === 5986,
      note: hint ? hint.note : `${port} 端口开放`,
    });
  });

  const ports = [...openPorts].sort((a, b) => a - b);

  if (ports.length === 0) {
    return {
      ip: host,
      openPorts: [],
      evidence: [],
      os: '',
      message: `目标 ${host} 没有响应：这些端口都连不上，可能被防火墙拦了、主机没开机，或 IP 不对`,
    };
  }

  const scores: Record<OsFamily, number> = { linux: 0, windows: 0, network: 0 };
  for (const item of evidence) scores[item.family] += item.strong ? 5 : item.windowsService ? 3 : 1;
  // 「读到了系统名」优先于「端口像某个系统」：Linux 主机开着 Samba 和 xrdp 时，
  // 端口信号加起来可能超过 SSH 横幅的分，但横幅才是硬证据。
  const strongCount = (family: OsFamily) => evidence.filter((item) => item.family === family && item.strong).length;
  const ranked = (Object.keys(scores) as OsFamily[]).sort(
    (a, b) => strongCount(b) - strongCount(a) || scores[b] - scores[a],
  );
  const top = ranked[0];
  const topScore = scores[top];

  if (topScore < MIN_SCORE) {
    return {
      ip: host,
      openPorts: ports,
      evidence,
      os: '',
      message: `探测到开放端口 ${ports.join(', ')}，但取不到能判定操作系统的特征`,
    };
  }

  // 强证据里挑一个版本名写进结论：IIS 的版本号能对应到 Windows Server 代次，
  // 比「内置 OpenSSH / Microsoft FTP」这类只说明是 Windows 的横幅更有信息量。
  const strongItems = evidence.filter((item) => item.family === top && item.strong);
  const explicit = strongItems.find((item) => /^(IIS|Microsoft HTTPAPI)/i.test(item.version ?? '')) ?? strongItems[0] ?? null;
  // 「疑似」只留给纯端口推断：两条以上 Windows 专属服务（有应答的 SMB/RDP、WinRM、IIS）同时出现才敢去掉
  const dedicatedSignals = new Set(
    evidence.filter((item) => item.family === 'windows' && item.windowsDedicated).map((item) => item.source),
  );
  const confident = Boolean(explicit) || (top === 'windows' && dedicatedSignals.size >= 2);
  // 带发行版的强证据优先；没有的话退回弱证据里读到的名字（例如 WinRM）
  const version = explicit?.version ?? evidence.find((item) => item.family === top)?.version ?? null;

  return {
    ip: host,
    openPorts: ports,
    evidence,
    os: formatOs(top, version, confident),
    message: null,
  };
}
