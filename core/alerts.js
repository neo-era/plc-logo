'use strict';
/**
 * Lõi thuần: luật cảnh báo có trễ chuyển, chống lặp 30 phút, báo hồi phục có trễ.
 * evaluate(state, snapshot, now) → { state, events: [{type:'raise'|'remind'|'clear', code}] }
 * Khi tủ offline / snapshot hỏng: các luật khác ĐÓNG BĂNG (không suy từ dữ liệu cũ, không báo hồi phục giả).
 */
const { vnMinute, deepNight, fullDay } = require('./schedule');
const MIN = 60e3;
const REMIND = 30 * MIN;
const REMIND_OF = { MAINT: 240 * MIN };    // khoá LOCAL khi sửa chữa: chỉ nhắc khi quá 4 giờ (quên vặn về)
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
  BAD_SNAPSHOT: 'Dữ liệu trạng thái từ gateway không hợp lệ',
  MAINT: 'Tủ đang KHOÁ TẠI TỦ (công tắc LOCAL) — PLC chạy lịch tại tủ / công tắc tay, không điều khiển từ xa',
  ELR_LOCK_DAY: 'Khoá ELR vẫn còn sau 07:00 — có mạch đang bị yêu cầu bật suốt ban ngày',
  ELR_TRIP: 'Rơ-le chống dòng rò (ELR) vừa tác động — đèn tạm cắt; đủ 3 lần sẽ khoá đến sáng',
  ELR_LOCK: 'KHOÁ ELR (rò điện): ELR tác động 3 lần — K1/K2/K3 bị khoá đến sáng (tự gỡ ban ngày), không bật từ xa được',
  MAINS_LOST: 'Mất điện lưới tại tủ (gateway đang chạy UPS)',
  REMOTE_LOST: 'PLC đã về lịch tại tủ — mất nhịp tim gateway quá 3 phút',
  QI_MISMATCH_K1: 'K1: lệnh và phản hồi contactor không khớp quá 60 giây',
  QI_MISMATCH_K2: 'K2: lệnh và phản hồi contactor không khớp quá 60 giây',
  NIGHT_OFF: 'Đèn TẮT ban đêm (K1 hoặc K2 không đóng sau hoàng hôn + 30 phút)',
  DAY_ON: 'Đèn SÁNG ban ngày quá 5 phút',
  SCHED_DRIFT: 'Lịch từ xa và lịch tại tủ lệch nhau quá 15 phút',
  CMD_FAILED: 'Lệnh điều khiển từ xa thất bại — contactor không xác nhận',
  CLOCK: 'Đồng hồ PLC mất giờ hoặc lệch quá 2 phút',
  LEGACY_NI: 'Bit NI1–NI3 cũ khác 0 — có thể đang cưỡng bức/khoá lịch ngoài ý muốn',
  GW_TEMP: 'Nhiệt độ gateway cao quá 75 °C',
  FORCED_NIGHT_OFF: 'TẮT CƯỠNG BỨC BAN ĐÊM',
  FORCED_EXPIRING: 'Sắp hết hạn tắt cưỡng bức — đèn sẽ TỰ BẬT lại',
};
// dòng "Việc cần làm" cho người trực
const ACTION = {
  OFFLINE: 'đèn vẫn chạy lịch tại tủ; kiểm tra SIM/router/nguồn gateway khi tiện',
  BAD_SNAPSHOT: 'kiểm tra gateway (khởi động lại, xem nhật ký)',
  MAINT: 'xác nhận đang có tổ sửa chữa tại tủ; xong việc phải vặn công tắc về REMOTE',
  ELR_LOCK_DAY: 'kiểm tra lịch từ xa và gateway; gỡ khoá cần lịch tắt ban ngày',
  ELR_TRIP: 'theo dõi; nếu tác động lặp lại, cử tổ trực kiểm tra cách điện tuyến cáp, trụ, đèn',
  ELR_LOCK: 'cử tổ trực kiểm tra cách điện tuyến cáp, trụ, đèn; nếu chưa xử lý rò, tối mai tủ sẽ đóng điện lại',
  MAINS_LOST: 'liên hệ điện lực / kiểm tra CB tổng, công tơ',
  REMOTE_LOST: 'kiểm tra gateway và cáp mạng gateway ↔ PLC',
  QI_MISMATCH_K1: 'kiểm tra contactor K1, MCCB nhánh, nguồn cuộn hút',
  QI_MISMATCH_K2: 'kiểm tra contactor K2, MCCB nhánh, nguồn cuộn hút',
  NIGHT_OFF: 'kiểm tra tại tủ: CB, contactor, lịch PLC, ELR',
  DAY_ON: 'kiểm tra lịch và contactor; tắt tay nếu cần',
  SCHED_DRIFT: 'cập nhật giờ T001/T002/T006 tại tủ cho khớp lịch từ xa',
  CMD_FAILED: 'mở app xem nhật ký lệnh; kiểm tra contactor tại tủ',
  CLOCK: 'kiểm tra NTP router/PLC; chỉnh đồng hồ PLC',
  LEGACY_NI: 'kiểm tra HMI/Modbus cũ đang ghi NI1–NI3',
  GW_TEMP: 'kiểm tra quạt/thông gió tủ',
  FORCED_NIGHT_OFF: 'thông báo tổ trực; cần tắt lâu hơn 2 giờ thì ra tủ cắt CB và vặn LOCAL',
  FORCED_EXPIRING: 'nếu hiện trường còn nguy hiểm, cử người ra tủ cắt CB và vặn LOCAL trước giờ tự bật',
};
const hhmm = t => { const d = new Date(t + 7 * 3600e3); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const CIRC = c => c === 'K1' ? 'K1 (kéo theo K2)' : c;

function initialState() { return { since: {}, clearSince: {}, raised: {}, lastNote: {}, frozen: false }; }

function evaluate(prev, s, now) {
  const st = { since: { ...prev.since }, clearSince: { ...(prev.clearSince || {}) }, raised: { ...prev.raised }, lastNote: { ...(prev.lastNote || {}) } };
  const events = [];
  const snap = s || {};
  const frozen = !snap.online || !snapshotOk(snap);
  // vừa hết đóng băng: tính lại thời gian giữ từ bây giờ (không dùng since cũ trước lúc mất kết nối)
  if (!frozen && prev.frozen) for (const code of Object.keys(st.since)) if (!ALWAYS.includes(code)) st.since[code] = now;
  st.frozen = frozen;
  const note = (type, code) => { events.push({ type, code, at: now }); st.lastNote[code] = now; };

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
      events.push(recur ? { type: 'raise', code, recurrence: true, at: now } : { type: 'raise', code, at: now });
      st.lastNote[code] = now;
    } else if (now - r.last >= (REMIND_OF[code] || REMIND)) {
      st.raised[code] = { ...r, last: now };
      note('remind', code);
    }
  }
  return { state: st, events };
}

function format(ev, station) {
  const head = ev.type === 'clear' ? '✅ ĐÃ HỒI PHỤC' : ev.type === 'remind' ? '⏰ NHẮC LẠI' : ev.recurrence ? '⚠️ TÁI PHÁT' : '⚠️ CẢNH BÁO';
  const at = Number.isFinite(ev.at) ? ev.at : Date.now();
  const d = ev.detail || {};
  let body = MSG[ev.code] || 'Sự kiện khác';
  if (ev.code === 'FORCED_NIGHT_OFF') {
    body += `: ${CIRC(d.circuit)} tắt từ ${hhmm(at)}` + (Number.isFinite(d.until) ? ` đến ${hhmm(d.until)}` : '') +
      (d.by ? `, người ra lệnh ${d.by}` : '') + (d.note ? `, lý do: ${String(d.note).slice(0, 200)}` : '') +
      (Number.isFinite(d.usedMin) ? `. Đêm nay đã dùng ${Math.round(d.usedMin + (Number.isFinite(d.nightMin) ? d.nightMin : (Number.isFinite(d.until) ? (d.until - at) / 60e3 : 0)))}/120 phút` : '');
  } else if (ev.code === 'FORCED_EXPIRING' && d.circuit) {
    body += `: ${CIRC(d.circuit)} sẽ TỰ BẬT lại lúc ${hhmm(d.until)}`;
  } else if (ev.code === 'CMD_FAILED' && d.circuit) {
    body += ` (${d.circuit} ${d.mode === 'off' ? 'TẮT' : d.mode === 'on' ? 'BẬT' : 'về lịch'}${d.by ? ', ' + d.by : ''})`;
  }
  const lines = [`${head} — ${station.stationId}${station.name ? ' (' + station.name + ')' : ''}`,
    `Lúc ${hhmm(at)}: ${body}`];
  if (ev.type !== 'clear') lines.push(`Việc cần làm: ${ACTION[ev.code] || 'kiểm tra tủ'}`);
  else lines.push('Việc cần làm: không');
  return lines.join('\n').slice(0, 2000);
}

module.exports = { initialState, evaluate, format, RULES, MSG, ACTION, snapshotOk, hhmm };
