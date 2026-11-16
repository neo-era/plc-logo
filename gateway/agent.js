'use strict';
/**
 * Gateway tại tủ: đọc PLC qua Modbus, tính tầng điều khiển bằng lõi thuần, nhận lệnh qua MQTT.
 * Mọi phụ thuộc tiêm từ ngoài (clock, modbus, mqtt, store, sun, ntp) → kiểm thử được bằng đồng hồ ảo + bộ mô phỏng.
 */
const S = require('../core/schedule');
const C = require('../core/commands');
const { sunTimes } = require('../core/sun');
const { POINTS, map } = require('../core/modbus-map');

const POLL_MS = 2000, HB_MS = 10000, PUBLISH_MS = 60000, SKEW_OK_SEC = 120, RTC_FIX_SEC = 90, RTC_FIX_GAP = 30 * 60000;
const RECENT_IDS = 32;

class Gateway {
  constructor({ stationId, clock, modbus, mqtt, store, ntpSynced = () => true, tempC = () => null, sun = null, log = () => {} }) {
    Object.assign(this, { stationId, clock, modbus, mqtt, store, ntpSynced, tempC, sunOverride: sun, log });
    const saved = store.load() || {};
    this.sched = S.restore(saved.sched);
    this.lastSeq = Number.isSafeInteger(saved.lastSeq) ? saved.lastSeq : 0;
    this.recentIds = Array.isArray(saved.recentIds) ? saved.recentIds.slice(-RECENT_IDS) : [];
    this.overrides = saved.overrides && typeof saved.overrides === 'object' ? saved.overrides : {};
    this.schedule = saved.schedule || null;
    this.hb = false; this.linkUpSince = null; this.plc = null; this.lastPublish = 0; this.lastPublished = '';
    this.lastHb = 0; this.lastPoll = 0; this.rtcFixAt = 0; this.pendingCmds = []; this.out = null;
    this.mbBackoff = 0; this.mbNextTry = 0; this.lastPersist = 0; this.lastPersisted = '';
    mqtt.onCommand(cmd => this.onCommand(cmd));
    mqtt.onConfig(cfg => this.onConfig(cfg));
  }

  /** Lưu bền. important = lastSeq/lệnh/lịch đổi → ghi ngay; còn lại (bộ đếm, phút tắt đêm) tối đa 1 lần/60 s để đỡ mòn thẻ nhớ. */
  persist(important = true) {
    const now = this.clock();
    if (!important && now - this.lastPersist < 60e3) return;
    const data = { sched: S.serialize(this.sched), lastSeq: this.lastSeq, recentIds: this.recentIds, overrides: this.overrides, schedule: this.schedule };
    const key = JSON.stringify(data);
    if (key === this.lastPersisted) return;
    try { this.store.save(data); this.lastPersisted = key; this.lastPersist = now; }
    catch (e) { this.log('persist lỗi', e.message); }          // không làm sập tiến trình / không bỏ ACK
  }
  sun(now) {
    if (this.sunOverride) return this.sunOverride;
    const d = new Date(now + 7 * 3600e3);
    return sunTimes(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  onConfig(cfg) {
    if (!cfg || !cfg.schedule) return;
    const v = S.validateSchedule(cfg.schedule, this.sun(this.clock()));
    if (v.errors.length) { this.log('config rejected', v.errors); return; }
    this.schedule = cfg.schedule; this.persist();
  }

  async readPlc() {
    const m = this.modbus;
    const [q] = [await m.readCoils(POINTS.Q2.address, 3)];
    const mm = await m.readCoils(map.M(15).address, 20);               // M15..M34
    const di = await m.readDiscrete(0, 6);
    const ni = await m.readCoils(POINTS.NI1.address, 3);
    const hr = await m.readHolding(map.RTC_HR, 4);
    const M = n => mm[n - 15];
    return {
      Q: { K1: q[0], K2: q[1], K3: q[2] },
      I: { K1: di[4], K2: di[5], K3: C.HAS_FEEDBACK.K3 ? di[3] : null },
      elrActive: M(15), elrLock: M(16), remoteOk: M(20), hbAlive: M(24),
      local: { K1: M(32), K2: M(33), K3: M(34) },
      maint: di[2], manual: di[1], legacyNI: ni.map(Number),
      rtc: { year: 2000 + (hr[0] & 255), month: hr[1] >> 8, day: hr[1] & 255, hour: hr[2] >> 8, minute: hr[2] & 255, second: hr[3] >> 8 },
    };
  }

  rtcSkewSec(rtc, now) {
    const plcMs = Date.UTC(rtc.year, rtc.month - 1, rtc.day, rtc.hour, rtc.minute, rtc.second) - 7 * 3600e3;
    return Math.round((plcMs - now) / 1000);
  }

  async tick() {
    const now = this.clock();
    if (now - this.lastPoll < POLL_MS) return;
    this.lastPoll = now;
    try {
      if (!this.modbus.connected) {
        if (now < this.mbNextTry) throw new Error('BACKOFF');
        await this.modbus.connect();
      }
      this.plc = await this.readPlc();
      if (this.linkUpSince === null) this.linkUpSince = now;
      this.mbBackoff = 0;
    } catch (e) {
      if (e.message !== 'BACKOFF') {
        this.mbBackoff = Math.min(this.mbBackoff ? this.mbBackoff * 2 : 2000, 30000);
        this.mbNextTry = now + this.mbBackoff;
      }
      this.plc = null; this.linkUpSince = null; this.modbus.close?.();
      if (this.out) this.out = { ...this.out, remoteEn: false, reasons: ['PLC_LINK_LOST'] };
      this.publishState(now);                      // chỉ gửi khi đổi trạng thái hoặc mỗi 60 s
      return;
    }
    const p = this.plc, sun = this.sun(now);
    p.skewSec = this.rtcSkewSec(p.rtc, now);

    // đồng bộ giờ dự phòng (NTP của LOGO! là chính)
    const sec = new Date(now).getUTCSeconds();
    if (this.ntpSynced() && (Math.abs(p.skewSec) > RTC_FIX_SEC || p.rtc.year < 2025) && sec >= 2 && sec <= 50 && now - this.rtcFixAt > RTC_FIX_GAP) {
      const d = new Date(now + 7 * 3600e3), bytes = [d.getUTCFullYear() % 100, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
      const bits = []; for (const b of bytes) for (let i = 0; i < 8; i++) bits.push(!!((b >> i) & 1));
      try { await this.modbus.writeCoils(map.RTC_WRITE_COIL, bits); this.rtcFixAt = now; this.log('rtc fixed'); } catch { /* lần sau */ }
    }

    if (now - this.lastHb >= HB_MS) {
      this.lastHb = now; this.hb = !this.hb;
      if (p.maint) this.overrides = {};
      const r = S.step(this.sched, {
        now, sun, schedule: this.schedule, overrides: this.overrides, timeSynced: this.ntpSynced(),
        skewOk: Math.abs(p.skewSec) <= SKEW_OK_SEC && p.rtc.year >= 2025, plcLinkUpSince: this.linkUpSince, maint: p.maint, plcQ: p.Q,
      });
      this.sched = r.state; this.out = r.out;
      if (r.out.clearOverrides) this.overrides = {};
      for (const c of ['K1', 'K2', 'K3']) {
        const o = this.overrides[c];
        if (o && (!(o.until > now) || r.out.reasons.includes('OVERRIDE_STALE_' + c))) delete this.overrides[c];
      }
      // V100.0..4 = HB, REMOTE_EN, K1_REQ, K2_REQ, K3_REQ — ghi một khung FC15
      try {
        await this.modbus.writeCoils(POINTS.HB.address, [this.hb, r.out.remoteEn, r.out.req.K1, r.out.req.K2, r.out.req.K3]);
      } catch { this.linkUpSince = null; }
      this.persist(false);
    }
    await this.progressCommands(now);
    this.publishState(now);
  }

  snapshot(now) {
    const p = this.plc;
    return {
      stationId: this.stationId, at: now, online: !!p,
      ...(p ? { Q: p.Q, I: p.I, elrActive: p.elrActive, elrLock: p.elrLock, remoteOk: p.remoteOk, maint: p.maint, manual: p.manual,
        local: p.local, legacyNI: p.legacyNI, plcClock: { ...p.rtc, skewSec: p.skewSec } } : {}),
      remoteEn: this.out ? this.out.remoteEn : false, req: this.out ? this.out.req : null, reasons: this.out ? this.out.reasons : [],
      overrides: this.overrides, gatewayTempC: this.tempC(), ntpSynced: this.ntpSynced(),
      flips: S.flipsLastHour(this.sched, now), nightOffMin: this.sched.night ? Math.round(this.sched.night.offMin) : 0,
      k3CooldownUntil: Number.isFinite(this.sched.k3OffSince) && now - this.sched.k3OffSince < S.K3_COOLDOWN ? this.sched.k3OffSince + S.K3_COOLDOWN : null,
    };
  }

  publishState(now, force = false) {
    const snap = this.snapshot(now);
    const key = JSON.stringify({ ...snap, at: 0, plcClock: snap.plcClock && { ...snap.plcClock, second: 0, skewSec: 0 } });
    if (force || key !== this.lastPublished || now - this.lastPublish >= PUBLISH_MS) {
      this.mqtt.publishState(snap); this.lastPublished = key; this.lastPublish = now;
    }
  }

  ack(cmd, status, extra = {}) { this.mqtt.publishAck({ cmdId: cmd.cmdId, seq: cmd.seq, status, at: this.clock(), ...extra }); }

  onCommand(cmd) {
    const now = this.clock(), p = this.plc;
    const ctx = {
      now, stationId: this.stationId, lastSeq: this.lastSeq, recentCmdIds: this.recentIds, timeSynced: this.ntpSynced(),
      sun: this.sun(now), maint: !!(p && p.maint), elrLock: !!(p && p.elrLock), remoteOk: p ? p.remoteOk : false,
      k1Requested: !!(this.out && this.out.req.K1), flipsLastHour: S.flipsLastHour(this.sched, now),
      nightOffUsedMin: this.sched.night ? this.sched.night.offMin : 0,
    };
    const r = C.accept(cmd, ctx);
    if (Number.isSafeInteger(r.newLastSeq)) this.lastSeq = r.newLastSeq;
    if (cmd && typeof cmd.cmdId === 'string' && r.status !== 'duplicate') this.recentIds = [...this.recentIds, cmd.cmdId].slice(-RECENT_IDS);
    if (r.status === 'received') {
      if (cmd.mode === 'auto') delete this.overrides[cmd.circuit];
      else this.overrides[cmd.circuit] = { mode: cmd.mode, until: cmd.until, setAt: r.setAt, cmdId: cmd.cmdId, ...(r.notifyGroup ? { notifyGroup: true } : {}) };
      this.pendingCmds.push({ cmd, status: 'received', at: now });
      this.lastHb = 0;                               // áp ngay ở lượt quét kế tiếp
    }
    this.persist();
    this.ack(cmd, r.status, r.reason ? { reason: r.reason } : (r.notifyGroup ? { notifyGroup: true } : {}));
  }

  async progressCommands(now) {
    const keep = [];
    for (const pc of this.pendingCmds) {
      const { cmd } = pc;
      const want = cmd.mode === 'auto' ? (this.out ? this.out.req[cmd.circuit] : null) : cmd.mode === 'on';
      if (pc.status === 'received' && this.out && this.out.remoteEn && this.out.req[cmd.circuit] === want) {
        pc.status = 'applied'; pc.appliedAt = now; this.ack(cmd, 'applied');
      } else if (pc.status === 'received' && now - pc.at > 30000) {
        this.ack(cmd, 'failed', { reason: (this.out && this.out.reasons.join(',')) || 'NOT_APPLIED' }); continue;
      }
      if (pc.status === 'applied' && this.plc) {
        const ev = C.evaluate({ circuit: cmd.circuit, want }, { Q: this.plc.Q[cmd.circuit], I: this.plc.I[cmd.circuit] }, now - pc.appliedAt);
        if (ev === 'confirmed') { this.ack(cmd, 'confirmed'); continue; }
        if (ev === 'failed') { this.ack(cmd, 'failed', { reason: this.plc.elrLock ? 'ELR_LOCK' : 'NO_FEEDBACK' }); continue; }
      }
      keep.push(pc);
    }
    this.pendingCmds = keep;
  }
}

module.exports = { Gateway, POLL_MS, HB_MS };
