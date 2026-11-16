'use strict';
/**
 * Client Modbus TCP tối giản (FC1, FC2, FC3, FC5, FC15), có timeout, kiểm khung chặt — không phụ thuộc thư viện ngoài.
 * Khung sai (protocol id ≠ 0, sai mã hàm, sai số byte) → huỷ kết nối để không bao giờ trả dữ liệu nhầm.
 */
const net = require('node:net');

class ModbusClient {
  constructor({ host, port = 502, unit = 1, timeoutMs = 2000, connectTimeoutMs = 3000 }) {
    Object.assign(this, { host, port, unit, timeoutMs, connectTimeoutMs });
    this.sock = null; this.tid = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); this.connected = false;
  }
  connect() {
    this.close();
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error('CONNECT_TIMEOUT')); }, this.connectTimeoutMs);
      const fail = e => { clearTimeout(timer); s.destroy(); reject(e); };
      s.setNoDelay(true);
      s.once('error', fail);
      s.once('connect', () => {
        clearTimeout(timer); s.removeListener('error', fail);
        this.sock = s; this.connected = true; this.buf = Buffer.alloc(0);
        s.on('data', d => { if (this.sock === s) this.onData(d); });
        s.on('error', () => {});
        s.on('close', () => { if (this.sock === s) this.dropAll(new Error('CLOSED')); });
        resolve();
      });
    });
  }
  dropAll(err) {
    this.connected = false; this.buf = Buffer.alloc(0);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  close() {
    const s = this.sock; this.sock = null;
    this.dropAll(new Error('CLOSED'));
    if (s) s.destroy();
  }
  abort(reason) { this.close(); return reason; }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 7) {
      if (this.buf.readUInt16BE(2) !== 0) return this.abort(this.close());
      const len = this.buf.readUInt16BE(4);
      if (len < 2 || len > 254) return this.abort(this.close());
      if (this.buf.length < 6 + len) return;
      const f = this.buf.subarray(0, 6 + len); this.buf = this.buf.subarray(6 + len);
      const tid = f.readUInt16BE(0), p = this.pending.get(tid);
      if (!p) continue;
      this.pending.delete(tid); clearTimeout(p.timer);
      const pdu = f.subarray(7);
      if ((pdu[0] & 0x7F) !== p.fc) { p.reject(new Error('BAD_FUNCTION')); this.close(); return; }
      if (pdu[0] & 0x80) { p.reject(new Error('MODBUS_EXCEPTION_' + pdu[1])); continue; }
      if (p.expectBytes !== null && (pdu[1] !== p.expectBytes || pdu.length !== 2 + p.expectBytes)) { p.reject(new Error('BAD_LENGTH')); this.close(); return; }
      p.resolve(pdu);
    }
  }
  request(pdu, expectBytes = null) {
    if (!this.connected || !this.sock) return Promise.reject(new Error('NOT_CONNECTED'));
    const tid = (this.tid = (this.tid + 1) & 0xFFFF);
    const h = Buffer.alloc(7); h.writeUInt16BE(tid, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(pdu.length + 1, 4); h[6] = this.unit;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid); reject(new Error('TIMEOUT'));
        this.close();                     // khung có thể đã tới dở dang → bỏ kết nối, lần sau kết nối mới
      }, this.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer, fc: pdu[0], expectBytes });
      this.sock.write(Buffer.concat([h, pdu]));
    });
  }
  async readBits(fc, addr, qty) {
    const r = await this.request(Buffer.from([fc, addr >> 8, addr & 255, qty >> 8, qty & 255]), Math.ceil(qty / 8));
    return Array.from({ length: qty }, (_, i) => !!((r[2 + (i >> 3)] >> (i & 7)) & 1));
  }
  readCoils(addr, qty) { return this.readBits(1, addr, qty); }
  readDiscrete(addr, qty) { return this.readBits(2, addr, qty); }
  async readHolding(addr, qty) {
    const r = await this.request(Buffer.from([3, addr >> 8, addr & 255, qty >> 8, qty & 255]), qty * 2);
    return Array.from({ length: qty }, (_, i) => r.readUInt16BE(2 + i * 2));
  }
  writeCoil(addr, v) { return this.request(Buffer.from([5, addr >> 8, addr & 255, v ? 0xFF : 0, 0])); }
  writeCoils(addr, bits) {
    const n = Math.ceil(bits.length / 8), b = Buffer.alloc(6 + n);
    b[0] = 15; b.writeUInt16BE(addr, 1); b.writeUInt16BE(bits.length, 3); b[5] = n;
    bits.forEach((v, i) => { if (v) b[6 + (i >> 3)] |= 1 << (i & 7); });
    return this.request(b);
  }
}

module.exports = { ModbusClient };
