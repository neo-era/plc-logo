'use strict';
/**
 * Lớp vỏ Modbus TCP cho bộ mô phỏng LogoV4 — hành vi bám theo LOGO! 8.4 thật (đã thử 20/5/2026):
 *  - coil 0..8191 = V-bit (byte×8+bit), 8192+ = Q, 8256+ = M; DI 0.. = I
 *  - HR n = (VB(2n) << 8) | VB(2n+1); HR 492..495 = đồng hồ (VB985 năm 2 số, 986 tháng, 987 ngày, 988 giờ, 989 phút, 990 giây)
 *  - FC15 vào coil 7880..7919 (V985..V989) = đặt giờ; FC06/FC16 vào HR 492..495 → PLC ngắt kết nối (RST)
 *  - allowIp: chỉ nhận kết nối từ IP này (Modbus chỉ cho gateway — thiết kế B2)
 */
const net = require('node:net');

function vByte(plc, b) {
  if (b >= 984 && b <= 991) {
    const r = plc.rtc();
    return { 984: 0, 985: r.year % 100, 986: r.month, 987: r.day, 988: r.hour, 989: r.minute, 990: r.second, 991: 0 }[b];
  }
  let v = 0;
  for (let bit = 0; bit < 8; bit++) if (plc.getCoilV(b * 8 + bit)) v |= 1 << bit;
  return v;
}

function readCoil(plc, a) {
  if (a >= 8256) return !!plc.M[a - 8256 + 1];
  if (a >= 8192) return !!plc.Q[a - 8192 + 1];
  if (a >= 7872 && a < 7936) return !!((vByte(plc, a >> 3) >> (a & 7)) & 1);
  return plc.getCoilV(a);
}

function createServer(plc, { allowIp = null, log = () => {} } = {}) {
  const pendingRtc = new Map();
  const server = net.createServer(sock => {
    const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    if (allowIp && ip !== allowIp) { log('reject', ip); sock.destroy(); return; }
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 7) {
        const len = buf.readUInt16BE(4);
        if (buf.length < 6 + len) break;
        const frame = buf.subarray(0, 6 + len); buf = buf.subarray(6 + len);
        const res = handle(frame);
        if (res === 'RST') { sock.destroy(); return; }
        sock.write(res);
      }
    });
  });

  function reply(frame, pdu) {
    const h = Buffer.alloc(7); frame.copy(h, 0, 0, 7); h.writeUInt16BE(pdu.length + 1, 4);
    return Buffer.concat([h, pdu]);
  }
  const exc = (frame, fc, code) => reply(frame, Buffer.from([fc | 0x80, code]));
  const bitsPdu = (fc, bits) => {
    const n = Math.ceil(bits.length / 8), b = Buffer.alloc(2 + n); b[0] = fc; b[1] = n;
    bits.forEach((v, i) => { if (v) b[2 + (i >> 3)] |= 1 << (i & 7); });
    return b;
  };

  function handle(f) {
    const fc = f[7], addr = f.readUInt16BE(8), qty = f.readUInt16BE(10);
    try {
      if (fc === 1) return reply(f, bitsPdu(1, Array.from({ length: qty }, (_, i) => readCoil(plc, addr + i))));
      if (fc === 2) return reply(f, bitsPdu(2, Array.from({ length: qty }, (_, i) => !!plc.I[addr + i + 1])));
      if (fc === 3) {
        const b = Buffer.alloc(2 + qty * 2); b[0] = 3; b[1] = qty * 2;
        for (let i = 0; i < qty; i++) { const n = addr + i; b.writeUInt16BE((vByte(plc, 2 * n) << 8) | vByte(plc, 2 * n + 1), 2 + i * 2); }
        return reply(f, b);
      }
      if (fc === 5) {
        if (addr >= 8192) return exc(f, fc, 2);                    // Q/M không ghi được từ ngoài
        plc.setCoilV(addr, qty === 0xFF00);
        return reply(f, f.subarray(7, 12));
      }
      if (fc === 15) {
        const bytes = f[12];
        const bits = []; for (let i = 0; i < qty; i++) bits.push(!!((f[13 + (i >> 3)] >> (i & 7)) & 1));
        if (addr >= 8192 || bytes !== Math.ceil(qty / 8)) return exc(f, fc, 2);
        if (addr === 7880 && qty === 40) {                          // đặt giờ
          const by = [0, 1, 2, 3, 4].map(k => bits.slice(k * 8, k * 8 + 8).reduce((a, v, j) => a | (v << j), 0));
          plc.setRtc({ year: 2000 + by[0], month: by[1], day: by[2], hour: by[3], minute: by[4], second: 0 });
        } else bits.forEach((v, i) => plc.setCoilV(addr + i, v));
        return reply(f, f.subarray(7, 12));
      }
      if (fc === 6 || fc === 16) {
        if (addr <= 495 && addr + (fc === 6 ? 1 : qty) > 492) return 'RST';
        return exc(f, fc, 1);                                       // không cần cho gateway
      }
      return exc(f, fc, 1);
    } catch { return exc(f, fc, 4); }
  }
  server.pendingRtc = pendingRtc;
  return server;
}

module.exports = { createServer };
