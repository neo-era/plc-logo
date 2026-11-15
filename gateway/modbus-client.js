'use strict';
/** Client Modbus TCP tối giản (FC1, FC2, FC3, FC5, FC15), có hàng đợi & timeout — không phụ thuộc thư viện ngoài. */
const net = require('node:net');

class ModbusClient {
  constructor({ host, port = 502, unit = 1, timeoutMs = 2000 }) {
    Object.assign(this, { host, port, unit, timeoutMs });
    this.sock = null; this.tid = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); this.connected = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const fail = e => { cleanup(); reject(e); };
      const cleanup = () => s.removeListener('error', fail);
      s.setNoDelay(true);
      s.once('error', fail);
      s.once('connect', () => {
        cleanup(); this.sock = s; this.connected = true;
        s.on('data', d => this.onData(d));
        s.on('error', () => {});
        s.on('close', () => { this.connected = false; for (const p of this.pending.values()) p.reject(new Error('CLOSED')); this.pending.clear(); });
        resolve();
      });
    });
  }
  close() { if (this.sock) this.sock.destroy(); this.connected = false; }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 7) {
      const len = this.buf.readUInt16BE(4);
      if (this.buf.length < 6 + len) return;
      const f = this.buf.subarray(0, 6 + len); this.buf = this.buf.subarray(6 + len);
      const p = this.pending.get(f.readUInt16BE(0));
      if (!p) continue;
      this.pending.delete(f.readUInt16BE(0)); clearTimeout(p.timer);
      if (f[7] & 0x80) p.reject(new Error('MODBUS_EXCEPTION_' + f[8])); else p.resolve(f.subarray(7));
    }
  }
  request(pdu) {
    if (!this.connected) return Promise.reject(new Error('NOT_CONNECTED'));
    const tid = (this.tid = (this.tid + 1) & 0xFFFF);
    const h = Buffer.alloc(7); h.writeUInt16BE(tid, 0); h.writeUInt16BE(0, 2); h.writeUInt16BE(pdu.length + 1, 4); h[6] = this.unit;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(tid); reject(new Error('TIMEOUT')); }, this.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer });
      this.sock.write(Buffer.concat([h, pdu]));
    });
  }
  async readBits(fc, addr, qty) {
    const r = await this.request(Buffer.from([fc, addr >> 8, addr & 255, qty >> 8, qty & 255]));
    return Array.from({ length: qty }, (_, i) => !!((r[2 + (i >> 3)] >> (i & 7)) & 1));
  }
  readCoils(addr, qty) { return this.readBits(1, addr, qty); }
  readDiscrete(addr, qty) { return this.readBits(2, addr, qty); }
  async readHolding(addr, qty) {
    const r = await this.request(Buffer.from([3, addr >> 8, addr & 255, qty >> 8, qty & 255]));
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
