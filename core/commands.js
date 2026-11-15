'use strict';
/** Lõi thuần: nhận lệnh tại gateway, máy trạng thái lệnh, đánh giá kết quả đọc lại. */
const { validateOverride } = require('./schedule');
const CIRCUITS = ['K1', 'K2', 'K3'];
const MODES = ['on', 'off', 'auto'];
const KINDS = ['override'];
const MAX_TTL = 60 * 1000;
const MAX_FUTURE = 5 * 1000;
const CONFIRM_MS = { K1: 10000, K2: 40000, K3: 10000 };
const HAS_FEEDBACK = { K1: true, K2: true, K3: false };   // K3 = true khi đã lắp tiếp điểm phụ I4

function wellFormed(c) {
  return c && typeof c === 'object'
    && typeof c.cmdId === 'string' && c.cmdId.length > 0 && c.cmdId.length <= 64
    && Number.isSafeInteger(c.seq) && c.seq > 0
    && typeof c.stationId === 'string'
    && KINDS.includes(c.kind) && CIRCUITS.includes(c.circuit) && MODES.includes(c.mode)
    && Number.isFinite(c.issuedAt) && Number.isFinite(c.expiresAt)
    && (c.mode === 'auto' || Number.isFinite(c.until));
}

function validCtx(x) {
  return x && Number.isFinite(x.now) && Number.isSafeInteger(x.lastSeq) && x.lastSeq >= 0
    && typeof x.stationId === 'string' && x.sun && Number.isFinite(x.sun.sunrise) && Number.isFinite(x.sun.sunset);
}

function accept(cmd, ctx) {
  if (!validCtx(ctx)) return { status: 'rejected', reason: 'BAD_CTX' };
  if (!wellFormed(cmd)) return { status: 'rejected', reason: 'BAD_COMMAND' };
  if (cmd.stationId !== ctx.stationId) return { status: 'rejected', reason: 'WRONG_STATION' };
  if (cmd.cmdId === ctx.lastCmdId || (Array.isArray(ctx.recentCmdIds) && ctx.recentCmdIds.includes(cmd.cmdId))) return { status: 'duplicate' };
  if (cmd.seq <= ctx.lastSeq) return { status: 'rejected', reason: 'REPLAY' };
  const base = { newLastSeq: cmd.seq };      // seq hợp lệ → luôn tiến, lệnh này không phát lại được
  if (cmd.expiresAt < cmd.issuedAt || cmd.expiresAt - cmd.issuedAt > MAX_TTL) return { ...base, status: 'rejected', reason: 'BAD_EXPIRY' };
  if (!ctx.timeSynced && cmd.mode !== 'auto') return { ...base, status: 'rejected', reason: 'NOT_SYNCED' };
  if (cmd.issuedAt > ctx.now + MAX_FUTURE) return { ...base, status: 'rejected', reason: 'ISSUED_IN_FUTURE' };
  if (ctx.now > cmd.expiresAt) return { ...base, status: 'expired', reason: 'EXPIRED' };
  // "Trả về tự động" chỉ gỡ cưỡng bức → luôn nhận (để dọn lệnh treo), kể cả khi khoá/REMOTE_OK = 0
  if (cmd.mode === 'auto') return { ...base, status: 'received', setAt: ctx.now, notifyGroup: false };
  if (ctx.maint) return { ...base, status: 'rejected', reason: 'MAINT' };
  if (ctx.elrLock && cmd.mode === 'on') return { ...base, status: 'rejected', reason: 'ELR_LOCK' };
  if (ctx.remoteOk === false) return { ...base, status: 'rejected', reason: 'REMOTE_NOT_OK' };
  const flips = ctx.flipsLastHour && ctx.flipsLastHour[cmd.circuit];
  if (cmd.mode !== 'auto' && Number.isFinite(flips) && flips >= 4) return { ...base, status: 'rejected', reason: 'RATE_LIMIT' };
  const v = validateOverride({ circuit: cmd.circuit, mode: cmd.mode, until: cmd.until }, ctx.now, ctx.sun, ctx.nightOffUsedMin);
  if (!v.ok) return { ...base, status: 'rejected', reason: 'OVERRIDE_' + v.code };
  if (cmd.circuit === 'K2' && cmd.mode === 'on' && !ctx.k1Requested) return { ...base, status: 'rejected', reason: 'K2_NEEDS_K1' };
  return { ...base, status: 'received', setAt: ctx.now, notifyGroup: !!v.notifyGroup };   // setAt theo giờ gateway
}

// Máy trạng thái lệnh
const NEXT = {
  new: ['received', 'rejected', 'expired', 'duplicate'],
  received: ['applied', 'failed', 'expired'],
  applied: ['confirmed', 'failed'],
};
const FINAL = ['confirmed', 'failed', 'expired', 'rejected', 'duplicate'];
function transition(from, to) {
  const ok = (NEXT[from] || []).includes(to);
  return ok ? { ok: true, status: to } : { ok: false, status: from, error: `INVALID_TRANSITION ${from}→${to}` };
}

/** readback: { Q: bool, I: bool|null } */
function evaluate(target, readback, elapsedMs, feedback = HAS_FEEDBACK) {
  if (!readback || typeof readback.Q !== 'boolean') return elapsedMs > CONFIRM_MS[target.circuit] ? 'failed' : 'pending';
  const qOk = readback.Q === target.want;
  let iOk;
  if (feedback[target.circuit]) iOk = typeof readback.I === 'boolean' && readback.I === target.want;
  else iOk = true;
  if (qOk && iOk) return 'confirmed';
  return elapsedMs > CONFIRM_MS[target.circuit] ? 'failed' : 'pending';
}

module.exports = { accept, evaluate, transition, wellFormed, CONFIRM_MS, HAS_FEEDBACK, FINAL };
