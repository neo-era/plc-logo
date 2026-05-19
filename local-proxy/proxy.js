/**
 * PLC LOGO! 230RCE — Local Modbus Proxy
 *
 *   Browser (plc.html) ─HTTP localhost:3001─▶ proxy.js ─Modbus TCP─▶ LOGO! 8
 *
 * Vì browser không nói được Modbus TCP raw (TCP socket bị cấm trong JS),
 * proxy này expose 4 endpoint HTTP để plc.html gọi:
 *   GET  /health                       → { plcConnected, plcHost, ... }
 *   POST /read    { addr }             → { value }
 *   POST /write   { addr, value }      → { ok: true }
 *   POST /batch   { points: [{addr,type}] } → { values: {addr:v,...}, ms }
 *
 * Địa chỉ dùng dạng LOGO! gốc: I1..I24, Q1..Q20, M1..M64, AI1..8, AQ1..8,
 *   VW0/VW2/.../VB0/VD0/...  → proxy tự ánh xạ sang Modbus address chuẩn Siemens.
 */
'use strict';

const http = require('http');
const ModbusRTU = require('modbus-serial');

// ── CLI ARGS ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}
const args = parseArgs(process.argv);
const PLC_HOST  = args['plc-host']  || process.env.PLC_HOST  || '192.168.0.3';
const PLC_PORT  = parseInt(args['plc-port']  || process.env.PLC_PORT  || '502', 10);
const SLAVE_ID  = parseInt(args['slave-id']  || process.env.SLAVE_ID  || '1',   10);
const HTTP_PORT = parseInt(args['port']      || process.env.HTTP_PORT || '3001',10);
const TIMEOUT   = parseInt(args['timeout']   || process.env.TIMEOUT   || '2000',10);

// ── LOGO! ↔ MODBUS MAPPING ────────────────────────────────────────────
// Chuẩn Siemens cho LOGO! 8 Modbus Slave.
//   I  / Q  / M  / NI / NQ      → bit  (digital)
//   AI / AQ / AM / NAI / NAQ    → word (analog/network analog)
//   VW / VB / VD                → V-area (variable memory)
// Lưu ý: NI/NQ là "Network Input/Output" — vùng bit GHI ĐƯỢC qua Modbus,
// dùng để browser/HMI tác động vào chương trình LOGO! (khác I1..I24 vật lý chỉ đọc).
function logoToModbus(addrRaw) {
  const addr = String(addrRaw).trim().toUpperCase();

  // ── V-bit: V<byte>.<bit> — truy cập bit trong V-area qua read-modify-write trên HR ──
  // V0.0 → HR 0, byte 0 (high byte trong VW0 theo big-endian Siemens), bit 0 (LSB byte)
  // Bắt trước regex chính vì có dấu "." không match được mẫu \d+ ở dưới.
  const vbit = addr.match(/^V(\d+)\.([0-7])$/);
  if (vbit) {
    const byte = parseInt(vbit[1], 10);
    const bit  = parseInt(vbit[2], 10);
    return {
      fc: 'holding',
      address: Math.floor(byte / 2),
      len: 1,
      vbit: true,
      bytePos: byte % 2,   // 0 = high byte (VB chẵn), 1 = low byte (VB lẻ)
      bitPos: bit,
    };
  }

  // Regex sắp xếp prefix dài trước (NAI/NAQ/NI/NQ/AI/AQ/AM) để không bị bắt nhầm.
  const m = addr.match(/^(NAI|NAQ|NI|NQ|AI|AQ|AM|VW|VB|VD|I|Q|M)(\d+)$/);
  if (!m) throw new Error('Địa chỉ LOGO! không hợp lệ: ' + addrRaw);
  const area = m[1];
  const num  = parseInt(m[2], 10);

  // ── Bit / digital ──
  if (area === 'I')  return { fc: 'discrete', address: num - 1,            len: 1 };          // I1  → DI    0       (chỉ đọc)
  if (area === 'Q')  return { fc: 'coil',     address: 8192 + (num - 1),   len: 1 };          // Q1  → Coil  8192
  if (area === 'M')  return { fc: 'coil',     address: 8256 + (num - 1),   len: 1 };          // M1  → Coil  8256
  if (area === 'NI') return { fc: 'coil',     address: 8320 + (num - 1),   len: 1 };          // NI1 → Coil  8320   ★ ghi được
  if (area === 'NQ') return { fc: 'coil',     address: 8384 + (num - 1),   len: 1 };          // NQ1 → Coil  8384   ★ ghi được

  // ── Word / analog ──
  if (area === 'AI')  return { fc: 'input',   address: num,                len: 1 };          // AI1  → IR  1        (chỉ đọc)
  if (area === 'AQ')  return { fc: 'holding', address: 512 + num,          len: 1 };          // AQ1  → HR  513
  if (area === 'AM')  return { fc: 'holding', address: 528 + num,          len: 1 };          // AM1  → HR  529
  if (area === 'NAI') return { fc: 'holding', address: 592 + num,          len: 1 };          // NAI1 → HR  593     ★ ghi được
  if (area === 'NAQ') return { fc: 'holding', address: 624 + num,          len: 1 };          // NAQ1 → HR  625

  // ── V-area ──
  if (area === 'VW') {
    if (num % 2 !== 0) throw new Error('VW phải là số chẵn (VW0, VW2, VW4...): ' + addrRaw);
    return { fc: 'holding', address: num / 2, len: 1 };                                       // VW0 → HR 0
  }
  if (area === 'VB') {
    return { fc: 'holding', address: Math.floor(num / 2), len: 1, byteOffset: num % 2 };      // VB0 → HR 0 high byte
  }
  if (area === 'VD') {
    if (num % 2 !== 0) throw new Error('VD phải là số chẵn (VD0, VD2, VD4...): ' + addrRaw);
    return { fc: 'holding', address: num / 2, len: 2, dword: true };                          // VD0 → HR 0,1
  }
  throw new Error('Vùng nhớ chưa hỗ trợ: ' + area);
}

function isReadOnly(m) { return m.fc === 'discrete' || m.fc === 'input'; }

// ── FRAME TAP — bắt raw bytes TX/RX để debug ─────────────────────────
const FRAMES_MAX = 500;
const frames = [];
let frameSeq = 0;

const FC_NAMES = {
  1: 'ReadCoils', 2: 'ReadDI', 3: 'ReadHR', 4: 'ReadIR',
  5: 'WriteCoil', 6: 'WriteReg', 15: 'WriteCoils', 16: 'WriteRegs',
};

function decodeFrame(dir, buf) {
  if (buf.length < 8) return { fc: null, detail: '(short)' };
  const fc = buf[7];
  const name = FC_NAMES[fc & 0x7F] || `FC${fc & 0x7F}`;
  if (fc & 0x80) return { fc, fcName: name + '!err', detail: `exception=${buf[8] ?? '?'}` };
  let detail = '';
  if (dir === 'TX') {
    if ([1, 2, 3, 4].includes(fc) && buf.length >= 12) {
      detail = `addr=${buf.readUInt16BE(8)} cnt=${buf.readUInt16BE(10)}`;
    } else if ([5, 6].includes(fc) && buf.length >= 12) {
      const addr = buf.readUInt16BE(8);
      const val = buf.readUInt16BE(10);
      detail = `addr=${addr} val=${fc === 5 ? (val === 0xFF00 ? 'ON' : (val === 0 ? 'OFF' : '0x' + val.toString(16))) : val}`;
    } else if ([15, 16].includes(fc) && buf.length >= 13) {
      detail = `addr=${buf.readUInt16BE(8)} cnt=${buf.readUInt16BE(10)} bytes=${buf[12]}`;
    }
  } else {
    if ([1, 2, 3, 4].includes(fc) && buf.length >= 9) {
      const n = buf[8];
      const data = buf.slice(9, 9 + Math.min(n, 16));
      detail = `bytes=${n}` + (data.length ? ` data=${data.toString('hex').toUpperCase()}` : '');
    } else if ([5, 6, 15, 16].includes(fc) && buf.length >= 12) {
      detail = `addr=${buf.readUInt16BE(8)} echo`;
    }
  }
  return { fc, fcName: name, detail };
}

function recordFrame(dir, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return;
  const dec = decodeFrame(dir, buf);
  frames.push({
    seq: ++frameSeq,
    ts: Date.now(),
    dir,
    hex: buf.toString('hex').toUpperCase().match(/.{1,2}/g).join(' '),
    len: buf.length,
    tid: buf.length >= 2 ? buf.readUInt16BE(0) : null,
    fc: dec.fc,
    fcName: dec.fcName,
    detail: dec.detail,
  });
  if (frames.length > FRAMES_MAX) frames.shift();
}

function attachFrameTap() {
  try {
    const port = client._port;
    if (!port || !port._client) return;
    const sock = port._client;
    if (sock._frameTapped) return;
    sock._frameTapped = true;

    const origWrite = sock.write.bind(sock);
    sock.write = function (chunk, ...args) {
      if (Buffer.isBuffer(chunk)) recordFrame('TX', chunk);
      return origWrite(chunk, ...args);
    };
    sock.on('data', buf => { if (Buffer.isBuffer(buf)) recordFrame('RX', buf); });
  } catch (e) {
    console.warn('[frames] không hook được socket:', e.message);
  }
}

// ── MODBUS CLIENT (single socket, serialized queue) ───────────────────
const client = new ModbusRTU();
client.setID(SLAVE_ID);
client.setTimeout(TIMEOUT);

let plcConnected = false;
let connecting = false;

async function connectModbus() {
  if (plcConnected || connecting) return;
  connecting = true;
  try {
    await client.connectTCP(PLC_HOST, { port: PLC_PORT });
    plcConnected = true;
    attachFrameTap();
    console.log(`[modbus] ✓ kết nối ${PLC_HOST}:${PLC_PORT} (slave ${SLAVE_ID})`);
  } catch (e) {
    plcConnected = false;
    console.warn(`[modbus] ✗ không kết nối được ${PLC_HOST}:${PLC_PORT} — ${e.message}. Retry sau 5s.`);
    setTimeout(connectModbus, 5000);
  } finally {
    connecting = false;
  }
}
client.on('close', () => {
  if (plcConnected) console.warn('[modbus] mất kết nối — retry sau 5s');
  plcConnected = false;
  setTimeout(connectModbus, 5000);
});

// modbus-serial chỉ cho 1 transaction tại 1 thời điểm trên cùng socket → serialize.
let mbQueue = Promise.resolve();
function withModbus(fn) {
  const job = mbQueue.then(async () => {
    if (!plcConnected) {
      await connectModbus();
      if (!plcConnected) throw new Error('PLC chưa kết nối');
    }
    return await fn();
  });
  mbQueue = job.catch(() => {});
  return job;
}

// ── READ / WRITE PRIMITIVES ───────────────────────────────────────────
async function readAddr(addrRaw) {
  const m = logoToModbus(addrRaw);
  return withModbus(async () => {
    if (m.fc === 'discrete') return (await client.readDiscreteInputs(m.address, 1)).data[0];
    if (m.fc === 'coil')     return (await client.readCoils(m.address, 1)).data[0];
    if (m.fc === 'input')    return (await client.readInputRegisters(m.address, 1)).data[0];
    if (m.fc === 'holding') {
      const r = await client.readHoldingRegisters(m.address, m.len);
      if (m.vbit) {
        const byteVal = m.bytePos === 0 ? (r.data[0] >> 8) & 0xFF : r.data[0] & 0xFF;
        return ((byteVal >> m.bitPos) & 1) === 1;
      }
      if (m.dword)              return ((r.data[0] << 16) >>> 0) | r.data[1];
      if (m.byteOffset != null) return m.byteOffset === 0 ? (r.data[0] >> 8) & 0xFF : r.data[0] & 0xFF;
      return r.data[0];
    }
    throw new Error('Không đọc được: ' + addrRaw);
  });
}

async function writeAddr(addrRaw, value) {
  const m = logoToModbus(addrRaw);
  if (isReadOnly(m)) throw new Error('Vùng chỉ đọc: ' + addrRaw);
  return withModbus(async () => {
    if (m.fc === 'coil') {
      await client.writeCoil(m.address, !!value);
      return true;
    }
    if (m.fc === 'holding') {
      if (m.vbit) {
        // Read-modify-write 1 bit trong V-area.
        const cur = (await client.readHoldingRegisters(m.address, 1)).data[0];
        let byteVal = m.bytePos === 0 ? (cur >> 8) & 0xFF : cur & 0xFF;
        if (value) byteVal |= (1 << m.bitPos);
        else       byteVal &= (~(1 << m.bitPos)) & 0xFF;
        const next = m.bytePos === 0 ? ((byteVal << 8) | (cur & 0x00FF)) : ((cur & 0xFF00) | byteVal);
        await client.writeRegister(m.address, next & 0xFFFF);
        return true;
      }
      if (m.dword) {
        const v = (parseInt(value, 10) || 0) >>> 0;
        await client.writeRegisters(m.address, [(v >>> 16) & 0xFFFF, v & 0xFFFF]);
      } else if (m.byteOffset != null) {
        const cur = (await client.readHoldingRegisters(m.address, 1)).data[0];
        const b = (parseInt(value, 10) || 0) & 0xFF;
        const next = m.byteOffset === 0 ? ((b << 8) | (cur & 0x00FF)) : ((cur & 0xFF00) | b);
        await client.writeRegister(m.address, next & 0xFFFF);
      } else {
        await client.writeRegister(m.address, (parseInt(value, 10) || 0) & 0xFFFF);
      }
      return true;
    }
    throw new Error('Không ghi được: ' + addrRaw);
  });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

const routes = {
  'GET /health': async () => ({
    ok: true,
    plcConnected,
    plcHost: `${PLC_HOST}:${PLC_PORT}`,
    slaveId: SLAVE_ID,
    uptimeSec: Math.round(process.uptime()),
  }),

  'POST /read': async (req) => {
    const { addr } = await readBody(req);
    if (!addr) throw new Error('Thiếu addr');
    const value = await readAddr(addr);
    return { addr, value: typeof value === 'boolean' ? value : Number(value) };
  },

  'POST /write': async (req) => {
    const { addr, value } = await readBody(req);
    if (!addr) throw new Error('Thiếu addr');
    if (value == null) throw new Error('Thiếu value');
    await writeAddr(addr, value);
    return { ok: true, addr, value };
  },

  'POST /batch': async (req) => {
    const { points } = await readBody(req);
    if (!Array.isArray(points)) throw new Error('points phải là mảng');
    const t0 = Date.now();
    const values = {};
    for (const pt of points) {
      try { values[pt.addr] = await readAddr(pt.addr); }
      catch (e) { values[pt.addr] = null; }
    }
    return { values, ms: Date.now() - t0, count: points.length };
  },

  'GET /frames': async (req) => {
    const url = new URL(req.url, 'http://x');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), FRAMES_MAX);
    const out = since > 0 ? frames.filter(f => f.seq > since) : frames.slice(-limit);
    return { frames: out, lastSeq: frameSeq, total: frames.length, max: FRAMES_MAX };
  },

  'POST /frames/clear': async () => {
    frames.length = 0;
    frameSeq = 0;
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }
  const key = req.method + ' ' + req.url.split('?')[0];
  const handler = routes[key];
  if (!handler) { send(res, 404, { error: 'Không có route: ' + key }); return; }
  try {
    const result = await handler(req);
    send(res, 200, result);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[http] sẵn sàng — http://localhost:${HTTP_PORT}`);
  console.log(`[http] endpoints: GET /health, POST /read, POST /write, POST /batch`);
});

// ── BOOTSTRAP ─────────────────────────────────────────────────────────
console.log(`[proxy] target PLC = ${PLC_HOST}:${PLC_PORT} (slave ${SLAVE_ID}), timeout ${TIMEOUT}ms`);
connectModbus();

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('[proxy] đang dừng...');
  try { client.close(() => {}); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}));
