'use strict';
/**
 * Nghiệp vụ dịch vụ plc: nhận trạng thái/ACK từ gateway, ra lệnh, sửa lịch, cảnh báo Zalo.
 * Lõi dùng chung với gateway (core/*) → server kiểm tra trước, gateway kiểm tra lại (phòng thủ hai lớp).
 */
const crypto = require('node:crypto');
const S = require('../../core/schedule');
const A = require('../../core/alerts');
const { sunTimes } = require('../../core/sun');

const CMD_TTL = 30e3;
const HISTORY_EVERY = 5 * 60e3;
const STALE_MS = 90e3;
const MIN_STATE_GAP = 1000;          // bỏ bản tin trạng thái dồn dập (< 1 s) — chống spam khi lộ khoá
const HISTORY_DAYS = 90;
const ACK_STATUSES = ['received', 'applied', 'confirmed', 'failed', 'expired', 'rejected', 'duplicate'];

const sunAt = now => { const d = new Date(now + 7 * 3600e3); return sunTimes(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }

function createService({ db, publish, zalo, now = Date.now, log = () => {} }) {
  const listeners = new Set();                 // WS app: (event) => void
  const alertState = new Map();                // stationId → state lõi cảnh báo
  const lastHistory = new Map();
  const emit = ev => { for (const f of listeners) { try { f(ev); } catch { /* bỏ qua */ } } };

  const q = (sql, params) => db.query(sql, params);
  const getStation = async id => (await q('select * from plc.stations where id = $1', [id])).rows[0] || null;

  async function canAccess(user, stationId) {
    if (user.role === 'admin') return true;
    const r = await q('select 1 from plc.station_users where station_id = $1 and user_id = $2', [stationId, user.id]);
    return r.rowCount > 0;
  }
  async function requireAccess(user, stationId, minRole) {
    const rank = { viewer: 1, editor: 2, admin: 3 };
    if (!user || !(rank[user.role] >= rank[minRole])) throw new HttpError(403, 'FORBIDDEN');
    if (!(await canAccess(user, stationId))) throw new HttpError(403, 'NO_STATION_ACCESS');
    const st = await getStation(stationId);
    if (!st) throw new HttpError(404, 'NOT_FOUND');
    return st;
  }

  // ── cảnh báo ──────────────────────────────────────────
  function snapshotFor(st, state, t) {
    const online = !!(st.online && state && t - Number(state.at || 0) < STALE_MS);
    const snap = { ...(state || {}), online, sun: sunAt(t) };
    if (online && Number.isFinite(state.gwSkewSec) && Math.abs(state.gwSkewSec) > 120) snap.plcClock = { ...(state.plcClock || {}), year: state.plcClock?.year ?? 2026, skewSec: state.gwSkewSec };
    if (online && state && state.req && state.local && state.remoteEn) {
      snap.schedMismatch = ['K1', 'K2', 'K3'].some(c => !state.overrides?.[c] && state.req[c] !== state.local[c]);
    }
    return snap;
  }
  async function runAlerts(st, state, extra = {}) {
    const t = now();
    const prev = alertState.get(st.id) || A.initialState();
    const r = A.evaluate(prev, { ...snapshotFor(st, state, t), ...extra }, t);
    alertState.set(st.id, r.state);
    for (const ev of r.events) await deliver(st, ev);
  }
  async function deliver(st, ev) {
    const text = A.format(ev, { stationId: st.id, name: st.name });
    const rec = (await q(`select * from plc.alert_recipients where active and kind = 'zalo' and (station_id is null or station_id = $1)`, [st.id])).rows;
    const delivery = [];
    for (const r of rec) {
      const res = zalo ? await zalo.sendMessage(r.chat_id, text) : { ok: false, error: 'NO_ZALO' };
      delivery.push({ to: r.chat_id, type: r.chat_type, ok: res.ok, error: res.error });
    }
    await q('insert into plc.alerts(station_id, code, type, message, at, delivery) values ($1,$2,$3,$4,$5,$6)',
      [st.id, ev.code, ev.type, text, new Date(now()), JSON.stringify(delivery)]);
    const failed = delivery.length === 0 || delivery.every(d => !d.ok);
    emit({ type: 'alert', stationId: st.id, code: ev.code, kind: ev.type, message: text, deliveryFailed: failed });
    if (failed) log('alert delivery failed', st.id, ev.code);
  }

  // ── từ gateway ────────────────────────────────────────
  const lastStateAt = new Map();
  async function onState(stationId, state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.stationId !== stationId) return;
    const t = now();
    if (t - (lastStateAt.get(stationId) || 0) < MIN_STATE_GAP) return;
    lastStateAt.set(stationId, t);
    // lệch giờ gateway ↔ server (T6): gateway gửi `at` theo giờ của nó
    state.gwSkewSec = Number.isFinite(state.at) ? Math.round((state.at - t) / 1000) : null;
    state.at = t;                                   // dùng giờ server để tính "cũ"
    const st = (await q('update plc.stations set last_state = $2, last_state_at = $3, online = true where id = $1 returning *',
      [stationId, JSON.stringify(state), new Date(t)])).rows[0];
    if (!st) return;
    const key = JSON.stringify([state.Q, state.remoteOk, state.maint, state.elrLock, state.online]);
    const lh = lastHistory.get(stationId);
    if (!lh || lh.key !== key || t - lh.at >= HISTORY_EVERY) {
      await q('insert into plc.state_history(station_id, at, state) values ($1,$2,$3)', [stationId, new Date(t), JSON.stringify(state)]);
      lastHistory.set(stationId, { key, at: t });
    }
    emit({ type: 'state', stationId, state });
    await runAlerts(st, state);
  }

  /** Trạng thái đệm khi gateway mất MQTT: chỉ ghi lịch sử (không đổi trạng thái hiện tại), tối đa 500 mẫu/lần kết nối. */
  const histCount = new Map(), histDaily = new Map();
  async function onHist(stationId, msg) {
    const items = Array.isArray(msg?.items) ? msg.items.slice(0, 20) : [];
    for (const it of items) {
      const n = histCount.get(stationId) || 0;
      if (n >= 500) return;
      if (!it || typeof it !== 'object' || it.stationId !== stationId || !Number.isFinite(it.at)) continue;
      if (it.at > now() || it.at < now() - 7 * 864e5) continue;                // chỉ nhận mẫu trong 7 ngày qua
      const day = Math.floor(now() / 864e5), dk = stationId + ':' + day;
      const dc = histDaily.get(dk) || 0; if (dc >= 5000) return;              // trần/ngày chống ghi vô hạn khi lộ khoá
      histDaily.set(dk, dc + 1);
      histCount.set(stationId, n + 1);
      await q('insert into plc.state_history(station_id, at, state) values ($1,$2,$3)', [stationId, new Date(it.at), JSON.stringify({ ...it, buffered: true })]);
    }
  }

  async function onAck(stationId, ack) {
    if (!ack || typeof ack.cmdId !== 'string' || !ACK_STATUSES.includes(ack.status)) return;
    const c = (await q('select * from plc.commands where cmd_id::text = $1 and station_id = $2', [ack.cmdId, stationId])).rows[0];
    if (!c) return;                                  // không nhận ACK cho lệnh của tủ khác
    await q('insert into plc.command_events(cmd_id, status, reason, at, detail) values ($1,$2,$3,$4,$5)',
      [c.cmd_id, ack.status, typeof ack.reason === 'string' ? ack.reason.slice(0, 200) : null, new Date(now()),
        JSON.stringify({ notifyGroup: !!ack.notifyGroup })]);
    emit({ type: 'ack', stationId, cmdId: ack.cmdId, status: ack.status, reason: ack.reason || null });
    const st = await getStation(stationId);
    if (ack.status === 'failed') await runAlerts(st, st.last_state, { cmdFailed: true });
    if (ack.status === 'received' && ack.notifyGroup) {
      await deliver(st, { type: 'raise', code: 'FORCED_NIGHT_OFF' });
    }
  }

  async function onOnline(stationId, online) {
    const st = (await q('update plc.stations set online = $2 where id = $1 returning *', [stationId, online])).rows[0];
    if (!st) return;
    emit({ type: 'online', stationId, online });
    if (online) histCount.set(stationId, 0);
    if (online && st.schedule) await publish(`lvc/${stationId}/config`, { schedule: st.schedule }, { retain: true });   // broker khởi động lại vẫn có lịch
    if (!online) await runAlerts(st, st.last_state);
  }

  /** Gọi định kỳ (30 s): tủ im lặng quá lâu → coi như offline cho luật cảnh báo. */
  let lastPurge = 0;
  async function sweep() {
    const t = now();
    // lệnh không tới được tủ (không có ACK sau hạn + 10 s) → expired, có lý do
    await q(`insert into plc.command_events(cmd_id, status, reason, at)
             select c.cmd_id, 'expired', 'NOT_DELIVERED', $1 from plc.commands c
             where c.expires_at < $2 and not exists (select 1 from plc.command_events e where e.cmd_id = c.cmd_id and e.status <> 'issued')`,
      [new Date(t), new Date(t - 10e3)]);
    if (t - lastPurge > 3600e3) { lastPurge = t; await q('delete from plc.state_history where at < $1', [new Date(t - HISTORY_DAYS * 864e5)]); }
    const rows = (await q('select * from plc.stations')).rows;
    for (const st of rows) {
      const stale = !st.last_state_at || now() - new Date(st.last_state_at).getTime() > STALE_MS;
      if (stale || !st.online) await runAlerts(st, st.last_state);
    }
  }

  // ── từ app ────────────────────────────────────────────
  async function issueCommand(user, stationId, body) {
    const st = await requireAccess(user, stationId, 'editor');
    const circuit = body?.circuit, mode = body?.mode;
    if (!['K1', 'K2', 'K3'].includes(circuit) || !['on', 'off', 'auto'].includes(mode)) throw new HttpError(400, 'BAD_COMMAND');
    const t = now(), sun = sunAt(t), ls = st.last_state || {};
    let until = null;
    if (mode !== 'auto') {
      const minutes = Number(body.minutes);
      if (!Number.isInteger(minutes) || minutes < 1) throw new HttpError(400, 'BAD_MINUTES');
      until = t + minutes * 60e3;
      const v = S.validateOverride({ circuit, mode, until }, t, sun, Number(ls.nightOffMin) || 0);
      if (!v.ok) throw new HttpError(422, 'OVERRIDE_' + v.code, v);
      if (ls.maint) throw new HttpError(409, 'MAINT');
      if (ls.elrLock && mode === 'on') throw new HttpError(409, 'ELR_LOCK');
      if (ls.flips && ls.flips[circuit] >= 4) throw new HttpError(429, 'RATE_LIMIT');
      if (circuit === 'K2' && mode === 'on' && !(ls.req && ls.req.K1)) throw new HttpError(409, 'K2_NEEDS_K1');
    }
    const seq = Number((await q('update plc.stations set next_seq = next_seq + 1 where id = $1 returning next_seq - 1 as seq', [stationId])).rows[0].seq);
    const cmd = {
      cmdId: crypto.randomUUID(), seq, stationId, kind: 'override', circuit, mode,
      ...(until ? { until } : {}), issuedAt: t, expiresAt: t + CMD_TTL, by: user.id,
    };
    await q(`insert into plc.commands(cmd_id, station_id, seq, circuit, mode, until_at, issued_at, expires_at, issued_by, note)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cmd.cmdId, stationId, seq, circuit, mode, until ? new Date(until) : null, new Date(t), new Date(cmd.expiresAt), user.id,
        typeof body.note === 'string' ? body.note.slice(0, 300) : null]);
    await q(`insert into plc.command_events(cmd_id, status, at) values ($1,'issued',$2)`, [cmd.cmdId, new Date(t)]);
    await publish(`lvc/${stationId}/cmd`, cmd, { retain: false });
    return cmd;
  }

  async function setSchedule(user, stationId, body) {
    await requireAccess(user, stationId, 'editor');
    const t = now();
    const v = S.validateSchedule(body?.schedule, sunAt(t));
    if (v.errors.length) throw new HttpError(422, 'BAD_SCHEDULE', { errors: v.errors });
    if (v.needsConfirm && !(body.confirm === true && typeof body.reason === 'string' && body.reason.trim().length >= 5)) {
      throw new HttpError(409, 'NEEDS_CONFIRM', { warnings: v.warnings });
    }
    const hist = (await q(`select at from plc.schedule_changes where station_id = $1 and at > $2`, [stationId, new Date(t - 3600e3)])).rows
      .map(r => new Date(r.at).getTime());
    if (!S.scheduleEditAllowed(hist, t).ok) throw new HttpError(429, 'SCHEDULE_RATE_LIMIT');
    const sched = {};
    for (const c of ['K1', 'K2', 'K3']) sched[c] = { on: body.schedule[c].on, off: body.schedule[c].off };
    await q('update plc.stations set schedule = $2 where id = $1', [stationId, JSON.stringify(sched)]);
    await q('insert into plc.schedule_changes(station_id, schedule, changed_by, reason, at) values ($1,$2,$3,$4,$5)',
      [stationId, JSON.stringify(sched), user.id, body.reason || null, new Date(t)]);
    await publish(`lvc/${stationId}/config`, { schedule: sched }, { retain: true });
    return { schedule: sched, warnings: v.warnings };
  }

  async function listStations(user) {
    const sql = user.role === 'admin'
      ? 'select id, name, online, last_state, last_state_at, schedule from plc.stations order by id'
      : `select s.id, s.name, s.online, s.last_state, s.last_state_at, s.schedule from plc.stations s
         join plc.station_users u on u.station_id = s.id where u.user_id = $1 order by s.id`;
    return (await q(sql, user.role === 'admin' ? [] : [user.id])).rows;
  }
  async function commandLog(user, stationId, limit = 50) {
    await requireAccess(user, stationId, 'viewer');
    const rows = (await q(`select c.*, coalesce(json_agg(json_build_object('status', e.status, 'reason', e.reason, 'at', e.at) order by e.id)
      filter (where e.id is not null), '[]') as events from plc.commands c left join plc.command_events e on e.cmd_id = c.cmd_id
      where c.station_id = $1 group by c.cmd_id order by c.issued_at desc limit $2`, [stationId, Math.min(Math.max(1, limit | 0), 200)])).rows;
    return rows;
  }

  return { onState, onAck, onHist, onOnline, sweep, issueCommand, setSchedule, listStations, commandLog, requireAccess, canAccess,
    getStation, listeners, HttpError };
}

module.exports = { createService, HttpError };
