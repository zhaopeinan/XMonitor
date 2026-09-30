import { Router } from 'express';
import { db } from './db';
import { getSetting } from './settings';
import { requirePermission } from './users';
import type { CandidateRow, MonitorRow } from './types';

export const monitorsRouter = Router();

/** 从勾选候选批量创建监控 */
monitorsRouter.post('/systems/:id/monitors', requirePermission('systems.manage'), (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });

  const ids: number[] = Array.isArray(req.body?.candidate_ids) ? req.body.candidate_ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'candidate_ids 不能为空' });

  const defaultInterval = Number(getSetting('default_interval_sec')) || 60;
  const defaultTimeout = Number(getSetting('default_timeout_sec')) || 15;
  const placeholders = ids.map(() => '?').join(',');
  const candidates = db
    .prepare(`SELECT * FROM candidates WHERE system_id = ? AND id IN (${placeholders})`)
    .all(systemId, ...ids) as CandidateRow[];

  const insert = db.prepare(
    `INSERT INTO monitors(system_id, name, type, url, method, headers, body, check_mode, expected_json, interval_sec, timeout_sec, enabled, expect_mode, status, consecutive_fail)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, 1, 'up', 'unknown', 0)`,
  );
  const markSelected = db.prepare('UPDATE candidates SET selected = 1 WHERE id = ?');
  const created: MonitorRow[] = [];
  for (const c of candidates) {
    const checkMode = c.type === 'page' ? 'browser' : 'http';
    const info = insert.run(systemId, c.title || c.url, c.type, c.url, c.method || 'GET', checkMode, defaultInterval, defaultTimeout);
    markSelected.run(c.id);
    created.push(db.prepare('SELECT * FROM monitors WHERE id = ?').get(info.lastInsertRowid) as MonitorRow);
  }
  res.status(201).json({ created });
});

monitorsRouter.patch('/monitors/:id', requirePermission('systems.manage'), (req, res) => {
  const id = Number(req.params.id);
  const monitor = db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | undefined;
  if (!monitor) return res.status(404).json({ error: '监控不存在' });

  const fields: Record<string, (v: unknown) => unknown> = {
    name: (v) => (typeof v === 'string' && v ? v : undefined),
    url: (v) => (typeof v === 'string' && v ? v : undefined),
    method: (v) => (typeof v === 'string' && v ? v.toUpperCase() : undefined),
    headers: (v) => (typeof v === 'string' || v === null ? v : undefined),
    body: (v) => (typeof v === 'string' || v === null ? v : undefined),
    check_mode: (v) => (v === 'http' || v === 'browser' ? v : undefined),
    expected_json: (v) => (typeof v === 'string' || v === null ? v : undefined),
    interval_sec: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined),
    timeout_sec: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined),
    enabled: (v) => (v === 0 || v === 1 || v === true || v === false ? (v ? 1 : 0) : undefined),
    expect_mode: (v) => (v === 'up' || v === 'down' ? v : undefined),
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, conv] of Object.entries(fields)) {
    if (!(key in (req.body ?? {}))) continue;
    const val = conv(req.body[key]);
    if (val === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  res.json(db.prepare('SELECT * FROM monitors WHERE id = ?').get(id));
});

monitorsRouter.delete('/monitors/:id', requirePermission('systems.manage'), (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '监控不存在' });
  db.prepare('DELETE FROM checks WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE monitor_id = ?').run(id);
  res.json({ ok: true });
});

/** 系统一键正/反向：将该系统下全部（或指定）监控项的 expect_mode 统一切换 */
monitorsRouter.post('/systems/:id/reverse', requirePermission('systems.manage'), (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });

  const enabled = req.body?.enabled;
  const mode = enabled === true || enabled === 1 || enabled === 'true' || enabled === 'down' ? 'down' : 'up';

  let selectedIds: number[] | undefined;
  if (Array.isArray(req.body?.monitor_ids)) {
    selectedIds = (req.body.monitor_ids as unknown[]).map(Number).filter(Number.isFinite);
    if (selectedIds.length === 0) return res.status(400).json({ error: 'monitor_ids 不能为空' });
  }

  if (selectedIds) {
    const placeholders = selectedIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE monitors SET expect_mode = ?, consecutive_fail = 0, status = 'unknown' WHERE system_id = ? AND id IN (${placeholders})`,
    ).run(mode, systemId, ...selectedIds);
  } else {
    db.prepare(
      `UPDATE monitors SET expect_mode = ?, consecutive_fail = 0, status = 'unknown' WHERE system_id = ?`,
    ).run(mode, systemId);
  }

  const monitors = db
    .prepare(
      `SELECT id, name, type, url, method, check_mode, enabled, expect_mode, status, last_check_at, last_latency_ms
       FROM monitors WHERE system_id = ? ORDER BY id`,
    )
    .all(systemId);
  const reverseCount = (monitors as { expect_mode: string }[]).filter((m) => m.expect_mode === 'down').length;
  res.json({
    ok: true,
    expect_mode: mode,
    reverse_count: reverseCount,
    total: monitors.length,
    monitors,
  });
});

/** 探测历史 */
monitorsRouter.get('/monitors/:id/checks', (req, res) => {
  const id = Number(req.params.id);
  const monitor = db.prepare('SELECT id FROM monitors WHERE id = ?').get(id);
  if (!monitor) return res.status(404).json({ error: '监控不存在' });
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const since = Date.now() - hours * 3600 * 1000;
  const checks = db
    .prepare('SELECT * FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts ASC')
    .all(id, since);
  res.json({ checks });
});
