'use strict';
/**
 * Lõi thuần: luật cảnh báo có trễ chuyển, chống lặp 30 phút, báo hồi phục có trễ.
 * evaluate(state, snapshot, now) → { state, events: [{type:'raise'|'remind'|'clear', code}] }
 * Khi tủ offline / snapshot hỏng: các luật khác ĐÓNG BĂNG (không suy từ dữ liệu cũ, không báo hồi phục giả).
 */
const { vnMinute, deepNight, fullDay } = require('./schedule');
const MIN = 60e3;
const REMIND = 30 * MIN;
const CLEAR_HOLD = 2 * MIN;     // điều kiện phải hết liên tục 2 phút mới báo hồi phục
const CLEAR_HOLD_LONG = { NIGHT_OFF: 10 * MIN, DAY_ON: 10 * MIN };   // luật dễ chập chờn: chờ lâu hơn, không im lặng

const active = (ov, c, mode, now) => !!(ov && ov[c] && ov[c].mode === mode && ov[c].until > now);
const mainsLost = s => s.mainsOk === false;

// [mã, ngưỡng ms, điều kiện(snap, now)]
const RULES = [
  ['OFFLINE', 5 * MIN, s => !s.online],
  ['BAD_SNAPSHOT', 1 * MIN, s => s.online && !snapshotOk(s)],
  ['MAINT', 0, s => s.maint === true],
  ['ELR_LOCK', 0, s => s.elrLock === true],
  ['ELR_LOCK_DAY', 0, (s, now) => s.elrLock === true && vnMinute(now) >= 7 * 60 && vnMinute(now) < 17 * 60],
  ['ELR_TRIP', 0, s => s.elrActive === true && s.elrLock !== true],
  ['MAINS_LOST', 1 * MIN, s => mainsLost(s)],
  ['REMOTE_LOST', 3 * MIN, s => s.remoteEn && !s.remoteOk && !s.maint],
  ['QI_MISMATCH_K1', 1 * MIN, s => !mainsLost(s) && s.I.K1 !== null && s.Q.K1 !== s.I.K1],
  ['QI_MISMATCH_K2', 1 * MIN, s => !mainsLost(s) && s.I.K2 !== null && s.Q.K2 !== s.I.K2],
  ['NIGHT_OFF', 5 * MIN, (s, now) => deepNight(vnMinute(now), s.sun) && ['K1', 'K2'].some(c => !s.Q[c] && !active(s.overrides, c, 'off', now) && !(c === 'K2' && active(s.overrides, 'K1', 'off', now))) && !mainsLost(s) && !s.elrLock && !s.maint],
  ['DAY_ON', 5 * MIN, (s, now) => fullDay(vnMinute(now), s.sun) && !s.maint && ['K1', 'K2', 'K3'].some(c => s.Q[c] && !active(s.overrides, c, 'on', now))],
  // lịch từ xa (yêu cầu) khác lịch tại tủ (M32–M34) liên tục > 15′ → lịch dự phòng không khớp
  ['SCHED_DRIFT', 15 * MIN, s => s.schedMismatch === true || (Number.isFinite(s.schedDriftMin) && s.schedDriftMin > 15)],
  ['CMD_FAILED', 0, s => s.cmdFailed === true],
  ['CLOCK', 2 * MIN, s => s.plcClock && (s.plcClock.year < 2025 || Math.abs(s.plcClock.skewSec) > 120)],
  ['LEGACY_NI', 1 * MIN, s => Array.isArray(s.legacyNI) && s.legacyNI.some(v => v)],
  ['GW_TEMP', 5 * MIN, s => s.gatewayTempC > 75],
];
const ALWAYS = ['OFFLINE', 'BAD_SNAPSHOT'];
const EVENT_CODES = ['CMD_FAILED', 'ELR_TRIP'];     // dạng sự kiện: không gửi tin "hồi phục"

function snapshotOk(s) {
  const bools = o => o && ['K1', 'K2', 'K3'].every(c => typeof o[c] === 'boolean' || o[c] === null);
  return !!(s && s.sun && Number.isFinite(s.sun.sunrise) && Number.isFinite(s.sun.sunset) && bools(s.Q) && bools(s.I));
}

const MSG = {
  OFFLINE: 'Tủ mất kết nối 4G/gateway quá 5 phút',
  BAD_SNAPSHOT: 'Dữ liệu trạng thái từ gateway không hợp lệ — kiểm tra gateway',
  MAINT: 'Tủ đang KHOÁ TẠI TỦ (công tắc LOCAL) — không điều khiển từ xa',
  ELR_LOCK_DAY: 'Khoá ELR vẫn còn sau 07:00 — có mạch đang bị yêu cầu bật suốt ban ngày (lịch/gateway lỗi?)',
  ELR_TRIP: 'Rơ-le chống dòng rò (ELR) vừa tác động — đèn tạm cắt; đủ 3 lần sẽ khoá đến sáng',
  ELR_LOCK: 'KHOÁ ELR: rơ-le chống dòng rò tác động 3 lần — K1/K2/K3 bị khoá đến sáng. Kiểm tra rò điện tại tủ (không gỡ được từ xa)',
  MAINS_LOST: 'Mất điện lưới tại tủ (gateway đang chạy UPS)',
  REMOTE_LOST: 'PLC đã về lịch tại tủ — mất nhịp tim gateway quá 3 phút',
  QI_MISMATCH_K1: 'K1: lệnh và phản hồi contactor không khớp quá 60 giây',
  QI_MISMATCH_K2: 'K2: lệnh và phản hồi contactor không khớp quá 60 giây',
  NIGHT_OFF: 'Đèn TẮT ban đêm (K1 hoặc K2 không đóng sau hoàng hôn + 30 phút)',
  DAY_ON: 'Đèn SÁNG ban ngày quá 5 phút',
  SCHED_DRIFT: 'Lịch từ xa và lịch tại tủ lệch nhau quá 15 phút — cập nhật lịch tại tủ',
  CMD_FAILED: 'Lệnh điều khiển từ xa thất bại — contactor không xác nhận',
  CLOCK: 'Đồng hồ PLC mất giờ hoặc lệch quá 2 phút',
  LEGACY_NI: 'Bit NI1–NI3 cũ khác 0 — có thể đang cưỡng bức/khoá lịch ngoài ý muốn',
  GW_TEMP: 'Nhiệt độ gateway cao quá 75 °C',
};

function initialState() { return { since: {}, clearSince: {}, raised: {}, lastNote: {}, frozen: false }; }

function evaluate(prev, s, now) {
  const st = { since: { ...prev.since }, clearSince: { ...(prev.clearSince || {}) }, raised: { ...prev.raised }, lastNote: { ...(prev.lastNote || {}) } };
  const events = [];
  const snap = s || {};
  const frozen = !snap.online || !snapshotOk(snap);
  // vừa hết đóng băng: tính lại thời gian giữ từ bây giờ (không dùng since cũ trước lúc mất kết nối)
  if (!frozen && prev.frozen) for (const code of Object.keys(st.since)) if (!ALWAYS.includes(code)) st.since[code] = now;
  st.frozen = frozen;
  const note = (type, code) => { events.push({ type, code }); st.lastNote[code] = now; };

  for (const [code, hold, cond] of RULES) {
    if (frozen && !ALWAYS.includes(code)) continue;          // đóng băng: giữ nguyên since/raised
    let on;
    try { on = !!cond(snap, now); } catch { on = false; }
    if (!on) {
      delete st.since[code];
      if (st.raised[code]) {
        if (st.clearSince[code] === undefined) st.clearSince[code] = now;
        if (now - st.clearSince[code] >= (CLEAR_HOLD_LONG[code] || CLEAR_HOLD) || hold === 0) {
          if (!EVENT_CODES.includes(code)) note('clear', code);
          delete st.raised[code]; delete st.clearSince[code];
        }
      }
      continue;
    }
    delete st.clearSince[code];
    if (st.since[code] === undefined) st.since[code] = now;
    if (now - st.since[code] < hold) continue;
    const r = st.raised[code];
    if (!r) {
      // tái phát sau khi đã báo hồi phục → luôn báo lại (kèm cờ tái phát), không im lặng
      const recur = st.lastNote[code] !== undefined && now - st.lastNote[code] < REMIND;
      st.raised[code] = { at: now, last: now };
      events.push(recur ? { type: 'raise', code, recurrence: true } : { type: 'raise', code });
      st.lastNote[code] = now;
    } else if (now - r.last >= REMIND) {
      st.raised[code] = { ...r, last: now };
      note('remind', code);
    }
  }
  return { state: st, events };
}

function format(ev, station) {
  const head = ev.type === 'clear' ? '✅ ĐÃ HỒI PHỤC' : ev.type === 'remind' ? '⏰ NHẮC LẠI' : ev.recurrence ? '⚠️ TÁI PHÁT' : '⚠️ CẢNH BÁO';
  const txt = `${head} — ${station.stationId}${station.name ? ' (' + station.name + ')' : ''}\n${MSG[ev.code] || ev.code}`;
  return txt.slice(0, 2000);
}

module.exports = { initialState, evaluate, format, RULES, MSG, snapshotOk };
