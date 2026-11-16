/* Tự sinh bởi scripts/build-web.js — KHÔNG sửa tay */
(function(){
const __m = {};
function require(p){ return __m[p.replace(/^\.\//, "")]; }
__m["sun"] = (function(){ const module = { exports: {} }; const exports = module.exports;
'use strict';
/**
 * Giờ mặt trời mọc/lặn (thuật toán NOAA rút gọn, độ cao −0,833°).
 * Trả phút trong ngày theo giờ địa phương (tz giờ). Không I/O.
 */
const HCM = { lat: 10.7769, lon: 106.7009, tz: 7 };

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

function dayOfYear(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) {
    throw new RangeError('Ngày không hợp lệ');
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new RangeError('Ngày không hợp lệ');
  return Math.round((dt - Date.UTC(y, 0, 1)) / 864e5) + 1;
}

function sunTimes(y, m, d, loc = HCM) {
  const n = dayOfYear(y, m, d);
  const g = 2 * Math.PI / 365 * (n - 1);           // phân số năm tại 0h
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(rad(90.833)) / (Math.cos(rad(loc.lat)) * Math.cos(decl))) - Math.tan(rad(loc.lat)) * Math.tan(decl);
  const ha = deg(Math.acos(Math.min(1, Math.max(-1, cosH))));
  const noonUtc = 720 - 4 * loc.lon - eqt;          // phút UTC
  const sunrise = Math.round(noonUtc - 4 * ha + loc.tz * 60);
  const sunset = Math.round(noonUtc + 4 * ha + loc.tz * 60);
  return { sunrise, sunset };
}

module.exports = { sunTimes, HCM, dayOfYear };

return module.exports; })();
__m["schedule"] = (function(){ const module = { exports: {} }; const exports = module.exports;
'use strict';
/**
 * Lõi thuần: kiểm lịch, kiểm lệnh cưỡng bức, bộ quyết định tầng cho gateway.
 * Không I/O, không đồng hồ hệ thống — mọi thời gian truyền vào (epoch ms).
 * Nguyên tắc an toàn: đầu vào hỏng → REMOTE_EN = 0 (PLC tự chạy lịch tại tủ).
 */
const MIN = 60 * 1000;
const DAY = 1440;
const VN_OFFSET = 7 * 60;
const CIRCUITS = ['K1', 'K2', 'K3'];
const NIGHT_LIGHTING = ['K1', 'K2'];     // mạch phải phủ cả đêm (K3 = HPS khung giờ riêng)
const MARGIN = 30;                       // phút quanh hoàng hôn / bình minh
const MAX_FLIPS_PER_HOUR = 4;
const K3_COOLDOWN = 15 * MIN;
const LINK_STABLE = 60 * 1000;
const MAX_FORCE = 12 * 60 * MIN;
const MAX_NIGHT_OFF_MIN = 120;
const STATE_VERSION = 1;

function parseHM(s) {
  if (typeof s !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const fmtHM = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

function isOnAt(w, minute) {
  if (w.on === w.off) return false;
  return w.on < w.off ? (minute >= w.on && minute < w.off) : (minute >= w.on || minute < w.off);
}

function vnMinute(epochMs) {
  const m = Math.floor(epochMs / MIN) + VN_OFFSET;
  return ((m % DAY) + DAY) % DAY;
}

const isNight = (minute, sun) => minute >= sun.sunset || minute < sun.sunrise;
const inRange = (m, a, b) => { a = (a + DAY) % DAY; b = (b + DAY) % DAY; return a <= b ? (m >= a && m < b) : (m >= a || m < b); };
const deepNight = (m, sun) => inRange(m, sun.sunset + MARGIN, sun.sunrise - MARGIN);
const fullDay = (m, sun) => inRange(m, sun.sunrise + MARGIN, sun.sunset - MARGIN);

function parseWindow(sched, c) {
  const on = parseHM(sched?.[c]?.on), off = parseHM(sched?.[c]?.off);
  return on === null || off === null || on === off ? null : { on, off };
}

function validateSchedule(sched, sun) {
  const errors = [], warnings = [];
  if (!sun || !Number.isFinite(sun.sunrise) || !Number.isFinite(sun.sunset)) return { errors: [{ code: 'BAD_SUN' }], warnings, needsConfirm: false };
  const w = {};
  for (const c of CIRCUITS) {
    const on = parseHM(sched?.[c]?.on), off = parseHM(sched?.[c]?.off);
    if (on === null || off === null) { errors.push({ circuit: c, code: 'BAD_TIME' }); continue; }
    if (on === off) { errors.push({ circuit: c, code: 'ON_EQ_OFF' }); continue; }
    w[c] = { on, off };
  }
  if (w.K1 && w.K2) {
    const fwd = (a, b) => ((b - a) % DAY + DAY) % DAY;
    const k2on = fwd(w.K1.on, w.K2.on), k2off = fwd(w.K1.on, w.K2.off), k1off = fwd(w.K1.on, w.K1.off);
    if (k2on < 1 || k2on >= k1off) errors.push({ circuit: 'K2', code: 'K2_ON_BEFORE_K1' });
    else if (k2off > k1off || k2off <= k2on) errors.push({ circuit: 'K2', code: 'K2_OFF_AFTER_K1' });
  }
  // Tính chính xác theo từng phút: đêm sâu không được phủ / ngày giữa trưa bị phủ
  for (const c of NIGHT_LIGHTING) {
    if (!w[c]) continue;
    let nightGap = 0, dayLit = 0;
    for (let m = 0; m < DAY; m++) {
      const on = isOnAt(w[c], m);
      if (deepNight(m, sun) && !on) nightGap++;
      if (fullDay(m, sun) && on) dayLit++;
    }
    if (nightGap > 0) {
      const lateOn = !isOnAt(w[c], (sun.sunset + MARGIN) % DAY);
      const earlyOff = !isOnAt(w[c], (sun.sunrise - MARGIN - 1 + DAY) % DAY);
      if (lateOn) warnings.push({ circuit: c, code: 'LATE_ON', limit: fmtHM((sun.sunset + MARGIN) % DAY), minutes: nightGap });
      if (earlyOff) warnings.push({ circuit: c, code: 'EARLY_OFF', limit: fmtHM((sun.sunrise - MARGIN + DAY) % DAY), minutes: nightGap });
      if (!lateOn && !earlyOff) warnings.push({ circuit: c, code: 'NIGHT_GAP', minutes: nightGap });
    }
    if (dayLit > 0) {
      const lateOff = isOnAt(w[c], (sun.sunrise + MARGIN) % DAY);
      warnings.push({ circuit: c, code: lateOff ? 'LATE_OFF' : 'DAY_ON', limit: fmtHM((sun.sunrise + MARGIN) % DAY), minutes: dayLit });
    }
  }
  if (w.K3) {
    let dayLit = 0;
    for (let m = 0; m < DAY; m++) if (fullDay(m, sun) && isOnAt(w.K3, m)) dayLit++;
    if (dayLit > 0) warnings.push({ circuit: 'K3', code: 'DAY_ON', minutes: dayLit });
  }
  return { errors, warnings, needsConfirm: warnings.length > 0 };
}

const MAX_SCHEDULE_EDITS_PER_HOUR = 6;
/** Giới hạn sửa lịch từ xa (dùng ở API server): history = dấu thời gian các lần sửa đã áp. */
function scheduleEditAllowed(history, now) {
  const recent = (Array.isArray(history) ? history : []).filter(t => Number.isFinite(t) && t <= now && now - t < 60 * MIN);
  return { ok: recent.length < MAX_SCHEDULE_EDITS_PER_HOUR, count: recent.length };
}

function defaultForceMinutes(now, sun) {
  return isNight(vnMinute(now), sun) ? 60 : 15;
}

/** Số phút đêm (hoàng hôn → bình minh) trong khoảng [from, to). */
function nightMinutesBetween(from, to, sun) {
  let n = 0;
  for (let t = from; t < to; t += MIN) if (isNight(vnMinute(t), sun)) n++;
  return n;
}

function validateOverride(o, now, sun, nightOffUsedMin = 0) {
  if (!Number.isFinite(now) || !sun) return { ok: false, code: 'BAD_INPUT' };
  if (!o || !CIRCUITS.includes(o.circuit) || !['on', 'off', 'auto'].includes(o.mode)) return { ok: false, code: 'BAD' };
  if (o.mode === 'auto') return { ok: true, notifyGroup: false };
  if (!Number.isFinite(o.until) || o.until <= now) return { ok: false, code: 'EXPIRED' };
  if (o.until - now > MAX_FORCE) return { ok: false, code: 'TOO_LONG' };
  if (o.mode === 'off') {
    const n = nightMinutesBetween(now, o.until, sun);
    if (n > MAX_NIGHT_OFF_MIN) return { ok: false, code: 'NIGHT_OFF_TOO_LONG', nightMinutes: n };
    const used = Number.isFinite(nightOffUsedMin) ? nightOffUsedMin : 0;
    if (n > 0 && used + n > MAX_NIGHT_OFF_MIN) return { ok: false, code: 'NIGHT_OFF_TOTAL_TOO_LONG', nightMinutes: n, used };
    return { ok: true, notifyGroup: n > 0, nightMinutes: n };
  }
  return { ok: true, notifyGroup: false };
}

// ── Bộ quyết định tầng ────────────────────────────────────
function initialState() {
  return { v: STATE_VERSION, req: null, flips: { K1: [], K2: [], K3: [] }, k3OffSince: null, lastQ3: null, maintAt: null, night: { key: null, offMin: 0, lastAt: null } };
}

const finiteArr = a => Array.isArray(a) && a.every(Number.isFinite);
/** Khôi phục state đã lưu bền (sau khởi động lại). Dữ liệu hỏng → state ban đầu. */
function restore(json) {
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    if (!o || o.v !== STATE_VERSION || !o.flips || !CIRCUITS.every(c => finiteArr(o.flips[c]))) return initialState();
    const req = o.req && CIRCUITS.every(c => typeof o.req[c] === 'boolean') ? { ...o.req } : null;
    const num = x => (Number.isFinite(x) ? x : null);
    return { v: STATE_VERSION, req, flips: { K1: [...o.flips.K1], K2: [...o.flips.K2], K3: [...o.flips.K3] },
      k3OffSince: num(o.k3OffSince), lastQ3: typeof o.lastQ3 === 'boolean' ? o.lastQ3 : null, maintAt: num(o.maintAt),
      night: o.night && Number.isFinite(o.night.offMin) ? { key: num(o.night.key), offMin: o.night.offMin, lastAt: num(o.night.lastAt) } : { key: null, offMin: 0, lastAt: null } };
  } catch { return initialState(); }
}
const serialize = st => JSON.stringify(st);

function clone(p) {
  return { v: STATE_VERSION, req: p.req && { ...p.req }, flips: { K1: [...p.flips.K1], K2: [...p.flips.K2], K3: [...p.flips.K3] },
    k3OffSince: p.k3OffSince, lastQ3: p.lastQ3 ?? null, maintAt: p.maintAt ?? null,
    night: p.night ? { ...p.night } : { key: null, offMin: 0, lastAt: null } };
}

/**
 * inp: { now, sun?, schedule, overrides{K*: {mode, until, setAt}}, timeSynced, skewOk, plcLinkUpSince, maint,
 *        plcQ?: {K1,K2,K3} (Q đọc thật từ PLC) }
 * out: { remoteEn, req{K1,K2,K3}, reasons[], clearOverrides }
 */
function step(prev, inp) {
  const st = clone(prev);
  const reasons = [];
  const now = inp?.now;
  const hold = (extra = {}) => ({ state: st, out: { remoteEn: false, req: { ...(st.req || { K1: false, K2: false, K3: false }) }, reasons, clearOverrides: false, ...extra } });

  if (!Number.isFinite(now)) { reasons.push('BAD_INPUT'); return hold(); }
  // dấu thời gian ở tương lai (file lưu hỏng / đồng hồ bị chỉnh lùi) → bỏ, không được khoá mạch mãi
  const FUT = now + 5000;
  for (const c of CIRCUITS) st.flips[c] = st.flips[c].filter(t => t <= FUT);
  if (st.k3OffSince !== null && st.k3OffSince > FUT) st.k3OffSince = null;
  if (st.maintAt !== null && st.maintAt > FUT) st.maintAt = null;
  if (!st.night || typeof st.night !== 'object') st.night = { key: null, offMin: 0, lastAt: null };

  // theo dõi K3 tắt thật (kể cả khi PLC đang chạy lịch tại tủ)
  const q3 = inp.plcQ && typeof inp.plcQ.K3 === 'boolean' ? inp.plcQ.K3 : null;
  if (q3 !== null) {
    if (st.lastQ3 === true && q3 === false) st.k3OffSince = now;   // bảo thủ: tính từ lúc thấy tắt
    st.lastQ3 = q3;
  }

  if (inp.maint) { st.maintAt = now; reasons.push('MAINT'); return hold({ clearOverrides: true }); }
  if (!inp.timeSynced) reasons.push('NOT_SYNCED');
  if (!inp.skewOk) reasons.push('CLOCK_SKEW');
  if (!Number.isFinite(inp.plcLinkUpSince) || now - inp.plcLinkUpSince < LINK_STABLE) reasons.push('LINK_UNSTABLE');
  const win = {};
  for (const c of CIRCUITS) win[c] = parseWindow(inp.schedule, c);
  if (!win.K1 || !win.K2) reasons.push('NO_SCHEDULE');
  if (reasons.length) return hold();

  const minute = vnMinute(now);
  const sched = {}, want = {}, forced = {};
  for (const c of CIRCUITS) {
    sched[c] = !!win[c] && isOnAt(win[c], minute);
    const ov = inp.overrides?.[c];
    const valid = ov && (ov.mode === 'on' || ov.mode === 'off') && Number.isFinite(ov.until) && ov.until > now
      && !(st.maintAt !== null && !(Number.isFinite(ov.setAt) && ov.setAt > st.maintAt));
    if (ov && (ov.mode === 'on' || ov.mode === 'off') && Number.isFinite(ov.until) && ov.until > now && !valid) reasons.push('OVERRIDE_STALE_' + c);
    forced[c] = !!valid;
    want[c] = valid ? ov.mode === 'on' : sched[c];
  }
  if (want.K2 && !want.K1) { want.K2 = false; reasons.push('K2_NEEDS_K1'); }

  const req = {}, chosen = {};
  for (const c of CIRCUITS) {
    st.flips[c] = st.flips[c].filter(t => now - t < 60 * MIN);
    const cur = st.req ? st.req[c] : null;
    let v = want[c];
    if (v !== cur && v !== sched[c] && st.flips[c].length >= MAX_FLIPS_PER_HOUR) {
      // giới hạn đóng cắt chỉ chặn chuyển do cưỡng bức đi xa lịch, không bao giờ chặn việc về đúng lịch
      v = cur === null ? sched[c] : cur; reasons.push('RATE_LIMIT_' + c);
    }
    if (c === 'K3' && v && (cur !== true || q3 === false) && st.k3OffSince !== null && now - st.k3OffSince < K3_COOLDOWN) {
      v = false; reasons.push('K3_COOLDOWN');
    }
    req[c] = v; chosen[c] = v;
  }
  if (req.K2 && !req.K1) req.K2 = false;  // bất biến cuối cùng
  for (const c of CIRCUITS) {
    const cur = st.req ? st.req[c] : null;
    if (req[c] !== cur && req[c] === chosen[c] && forced[c] && req[c] !== sched[c]) st.flips[c].push(now);   // đếm sau bất biến: chỉ chuyển do cưỡng bức đi XA lịch
  }
  if (q3 === null && st.req && st.req.K3 && !req.K3) st.k3OffSince = now;
  // cộng dồn số phút K1 bị tắt cưỡng bức trong đêm hiện tại (khoá đêm = ngày của giờ VN lùi 12 h)
  const nightKey = Math.floor((now / MIN + VN_OFFSET - 720) / DAY);
  if (st.night.key !== nightKey) st.night = { key: nightKey, offMin: 0, lastAt: now };
  else {
    // một phút được tính khi có ít nhất một mạch bị tắt cưỡng bức trong lúc lịch của nó đang bật (đêm)
    const forcedDark = CIRCUITS.some(c => forced[c] && !req[c] && sched[c]);
    if (forcedDark && isNight(minute, inp.sun || { sunrise: 360, sunset: 1050 }) && Number.isFinite(st.night.lastAt)) st.night.offMin += Math.max(0, (now - st.night.lastAt) / MIN);
    st.night.lastAt = now;
  }
  st.req = req;
  return { state: st, out: { remoteEn: true, req: { ...req }, reasons, clearOverrides: false } };
}

const flipsLastHour = (st, now) => Object.fromEntries(CIRCUITS.map(c => [c, (st.flips[c] || []).filter(t => t <= now + 5000 && now - t < 60 * MIN).length]));

module.exports = {
  scheduleEditAllowed, flipsLastHour, MAX_SCHEDULE_EDITS_PER_HOUR,
  CIRCUITS, MARGIN, parseHM, fmtHM, isOnAt, vnMinute, isNight, deepNight, fullDay, validateSchedule,
  defaultForceMinutes, nightMinutesBetween, validateOverride, initialState, restore, serialize, step,
};

return module.exports; })();
window.PLCCore = { sun: __m.sun, schedule: __m.schedule };
})();
