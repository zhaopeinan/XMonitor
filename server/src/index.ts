import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes';
import { initWS } from './ws';
import { startScheduler } from './scheduler';
import { seedDefaultAdmin } from './users';

seedDefaultAdmin();

// 最后防线：任何未捕获的异常都不应直接打死监控进程
process.on('uncaughtException', (err) => {
  console.error('[xmonitor] 未捕获异常（进程继续运行）:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[xmonitor] 未处理的 Promise 拒绝（进程继续运行）:', reason);
});

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use('/api', apiRouter);

// 托管 web/dist 静态文件（存在时），非 /api 非 /ws 的 GET 回退到 index.html
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDist = path.join(rootDir, 'web', 'dist');
const indexHtml = path.join(webDist, 'index.html');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
    next();
  });
}

// /api 未匹配路由返回 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[express] 未处理错误:', err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
});

const server = http.createServer(app);
initWS(server);
startScheduler();

const port = Number(process.env.PORT) || 8790;
server.listen(port, () => {
  console.log(`[xmonitor] 服务已启动: http://127.0.0.1:${port} (WS: /ws)`);
});
