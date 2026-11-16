'use strict';
/**
 * Bộ mô phỏng LOGO! 8.4 chạy chương trình NisseLOGOProgram_V4-4G (thiết kế mục 4.2).
 * Máy trạng thái thuần: đồng hồ ảo, chạy theo chu kỳ quét 100 ms. Không I/O — lớp Modbus ở sim/modbus-server.js.
 */
const SCAN = 100;
const S = 1000, MIN = 60 * S;
const VN = 7 * 60 * MIN;

const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const inWin = (w, m) => (w.on < w.off ? m >= w.on && m < w.off : m >= w.on || m < w.off);

class LogoV4 {
  constructor({ clock, weekly } = {}) {
    this.clock = clock ?? Date.now();
    this.rtcOffset = 0;
    this.weekly = weekly || { T001: { on: hm('17:45'), off: hm('05:45') }, T002: { on: hm('17:46'), off: hm('05:45') }, T006: { on: hm('22:00'), off: hm('04:00') } };
    this.I = Array(9).fill(false);           // I1..I8 do người thử đặt (I4/I5/I6 = phản hồi, mô hình theo Q)
    this.fault = {};                          // vd { I5: false } ép phản hồi K1 không lên
    this.C009 = 0;                            // Rem = on
    this.powerUp();
  }
  get now() { return this.clock; }
  powerUp() {
    this.V = new Map();                      // VM bị xoá khi mất nguồn
    this.M = Array(65).fill(false);
    this.Q = Array(5).fill(false);
    this.T = {};                             // trạng thái timer (Rem = off)
    this.prevM15 = false;
    this.since = {};
  }
  powerCycle() { this.powerUp(); }
  setI(n, v) { this.I[n] = !!v; }
  setV(byte, bit, v) { this.V.set(byte * 8 + bit, !!v); }
  getV(byte, bit) { return !!this.V.get(byte * 8 + bit); }
  getCoilV(addr) { return !!this.V.get(addr); }
  setCoilV(addr, v) { this.V.set(addr, !!v); }

  rtcMs() { return this.clock + this.rtcOffset; }
  rtc() {
    const d = new Date(this.rtcMs() + VN);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  }
  setRtc({ year, month, day, hour, minute, second = 0 }) {
    this.rtcOffset = Date.UTC(year, month - 1, day, hour, minute, second) - VN - this.clock;
  }

  onDelay(name, trg, ms) {
    const t = this.T[name] || (this.T[name] = { start: null });
    if (!trg) { t.start = null; return false; }
    if (t.start === null) t.start = this.clock;
    return this.clock - t.start >= ms;
  }
  offDelay(name, trg, ms) {
    const t = this.T[name] || (this.T[name] = { last: null });
    if (trg) { t.last = this.clock; return true; }
    return t.last !== null && this.clock - t.last < ms;
  }

  scan() {
    const r = this.rtc(), minute = r.hour * 60 + r.minute;
    const T001 = inWin(this.weekly.T001, minute), T002 = inWin(this.weekly.T002, minute), T006 = inWin(this.weekly.T006, minute);
    const NI1 = this.getV(0, 0), NI2 = this.getV(0, 1), NI3 = this.getV(0, 2);
    const HB = this.getV(100, 0), REN = this.getV(100, 1), R1 = this.getV(100, 2), R2 = this.getV(100, 3), R3 = this.getV(100, 4);
    const I1 = this.I[1], I2 = this.I[2], I3 = this.I[3];
    const M = this.M, prevQ2 = this.Q[2], prevQ4 = this.Q[4];

    // 1. watchdog
    const T010 = this.offDelay('T010', HB, 180 * S), T011 = this.offDelay('T011', !HB, 180 * S);
    M[24] = T010 && T011;
    // 2. REMOTE_OK, 3. bộ chọn
    M[20] = REN && M[24] && !I3;
    M[21] = (R1 && M[20]) || (T001 && !M[20]);
    M[22] = (R2 && M[20]) || (T002 && !M[20]);
    M[23] = (R3 && M[20]) || (T006 && !M[20]);
    M[32] = T001; M[33] = T002; M[34] = T006;
    // tay / NI1 / liên động
    const T004 = this.onDelay('T004', I2, 15 * MIN), T005 = this.onDelay('T005', NI1, 15 * MIN);
    const T003 = this.onDelay('T003', prevQ2, 30 * S);
    M[2] = (M[21] || (I2 && !M[21] && !T004) || (NI1 && !I3 && !M[21] && !T005)) && !NI2;
    M[3] = ((M[22] && T003) || (((I2 && !M[22] && !T004) || (NI1 && !I3 && !M[22] && !T005)) && T003)) && !NI3;
    // ELR
    const T008prev = this.onDelay('T008', this.prevM15, 15 * S);
    M[15] = (I1 || this.prevM15) && !T008prev;
    if (M[15] && !this.prevM15) this.C009 = Math.min(this.C009 + 1, 999999);
    this.prevM15 = M[15];
    if (!T001 && !M[2] && !M[3] && !M[23]) this.C009 = 0;          // reset V4
    const C009 = this.C009 >= 3; M[16] = C009;
    // K3 nguội
    const T012 = this.offDelay('T012', prevQ4, 15 * MIN);
    M[35] = T012 && !prevQ4;
    // ngõ ra
    const Q = this.Q;
    Q[2] = !M[15] && !C009 && M[2];
    Q[3] = !M[15] && !C009 && M[3];
    Q[4] = !M[15] && !C009 && M[23] && !M[35];
    if (Q[2] && !prevQ2) this.since.Q2on = this.clock;
    // phản hồi contactor
    this.I[5] = this.fault.I5 ?? Q[2]; this.I[6] = this.fault.I6 ?? Q[3]; this.I[4] = this.fault.I4 ?? Q[4];
    M[4] = M[2] && this.I[5]; M[5] = M[3] && this.I[6]; M[6] = M[4] && M[5];
  }

  run(ms) {
    const end = this.clock + ms;
    while (this.clock < end) { this.clock += SCAN; this.scan(); }
  }
}

module.exports = { LogoV4, SCAN };
