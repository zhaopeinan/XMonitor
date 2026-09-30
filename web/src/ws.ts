export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

type Listener = (msg: WsMessage) => void;

const listeners = new Set<Listener>();

export function subscribeWs(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---- 未读告警计数（用于 document.title 角标） ----

let unread = 0;
const unreadListeners = new Set<(n: number) => void>();

function emitUnread() {
  unreadListeners.forEach((fn) => fn(unread));
}

function updateTitle() {
  document.title = unread > 0 ? `(${unread}) XMonitor · 页面与接口监控` : 'XMonitor · 页面与接口监控';
}

export function subscribeUnread(fn: (n: number) => void): () => void {
  unreadListeners.add(fn);
  fn(unread);
  return () => {
    unreadListeners.delete(fn);
  };
}

export function resetUnread() {
  unread = 0;
  updateTitle();
  emitUnread();
}

// ---- 提示音（WebAudio 蜂鸣，无需音频文件） ----

let audioCtx: AudioContext | null = null;

function beep() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  } catch {
    // 用户未与页面交互前浏览器可能阻止音频，静默忽略
  }
}

// ---- 连接状态 ----

let connected = false;
const connListeners = new Set<(ok: boolean) => void>();

function setConnected(ok: boolean) {
  if (connected === ok) return;
  connected = ok;
  connListeners.forEach((fn) => fn(ok));
}

export function subscribeConnection(fn: (ok: boolean) => void): () => void {
  connListeners.add(fn);
  fn(connected);
  return () => {
    connListeners.delete(fn);
  };
}

// ---- WebSocket 连接（断线指数退避重连） ----

let ws: WebSocket | null = null;
let attempts = 0;
let started = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    attempts = 0;
    setConnected(true);
  };

  ws.onmessage = (ev) => {
    let msg: WsMessage;
    try {
      msg = JSON.parse(ev.data as string) as WsMessage;
    } catch {
      return;
    }
    if (msg.type === 'alert') {
      unread += 1;
      updateTitle();
      emitUnread();
      beep();
    }
    listeners.forEach((fn) => fn(msg));
  };

  ws.onclose = (ev) => {
    setConnected(false);
    if (ev.code === 4401) {
      // 未登录：停止重连，等待登录事件
      started = false;
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** attempts);
    attempts += 1;
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function startWs() {
  if (started) return;
  started = true;
  connect();
}

// 登录成功后恢复 WS 连接（被 4401 拒绝后会停止重连）
window.addEventListener('xm:logged-in', () => startWs());
