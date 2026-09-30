import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { buildDashboard } from './dashboard';
import { SESSION_COOKIE, getSessionUser, parseCookies } from './users';

const clients = new Set<WebSocket>();

export function initWS(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // 未登录的 WS 连接直接拒绝
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!getSessionUser(token)) {
      ws.close(4401, 'unauthorized');
      return;
    }
    clients.add(ws);
    void buildDashboard()
      .then((payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'snapshot', payload }));
        }
      })
      .catch(() => {
        // ignore
      });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

export function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }
}

export function wsClientCount(): number {
  let n = 0;
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) n += 1;
  }
  return n;
}
