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
const net = require('net');
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
    // Cleanup socket cũ trước khi retry — modbus-serial không tự destroy
    // half-open socket → tích tụ dần đến khi LOGO! hit max 8 connections.
    try {
      if (client._port && client._port._client) {
        client._port._client.destroy();
      }
      client.close(() => {});
    } catch {}
    await client.connectTCP(PLC_HOST, { port: PLC_PORT });
    plcConnected = true;
    attachFrameTap();
    console.log(`[modbus] ✓ kết nối ${PLC_HOST}:${PLC_PORT} (slave ${SLAVE_ID})`);
  } catch (e) {
    plcConnected = false;
    // Đảm bảo socket bị destroy ngay cả khi connect fail.
    try { if (client._port && client._port._client) client._port._client.destroy(); } catch {}
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
function isConnectionLost(err) {
  // CHỈ trigger reconnect khi socket thực sự chết. "Timed out" có thể chỉ là
  // 1 op chậm — không nên đóng socket vì sẽ làm sập các op sau.
  const msg = (err && err.message) || '';
  if (msg === 'Port Not Open') return true;
  if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) return true;
  return false;
}
function withModbus(fn) {
  const job = mbQueue.then(async () => {
    if (!plcConnected) {
      await connectModbus();
      if (!plcConnected) throw new Error('PLC chưa kết nối');
    }
    try {
      return await fn();
    } catch (e) {
      // Nếu lỗi cho thấy connection đã chết → reset flag + trigger reconnect
      // (modbus-serial đôi khi không fire 'close' event khi half-open).
      if (isConnectionLost(e)) {
        console.warn('[modbus] phát hiện connection lost qua error:', e.message, '— reset + reconnect');
        plcConnected = false;
        try { client.close(() => {}); } catch {}
        setTimeout(connectModbus, 1000);
      }
      throw e;
    }
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

// Rate limit state cho /test-rtc-write (đặt trước routes để TDZ không vấn đề)
let lastTestRtcWriteTs = 0;
const TEST_RTC_COOLDOWN_MS = 60000;  // 60 giây giữa các FC06 test write

// Rate limit RIÊNG cho FC16 destructive test (5 phút — tránh 3-strike wipe)
let lastFc16TestTs = 0;
const FC16_TEST_COOLDOWN_MS = 300000;  // 5 phút

// ── S7 protocol helpers (cho PLC Stop/Start qua port 102) ──
const S7_PORT = 102;
const S7_TSAP_SRC = [0x02, 0x00];  // Source TSAP 0x0200 (PG/Soft Comfort)
const S7_TSAP_DST = [0x02, 0x00];  // Dest TSAP 0x0200 (LOGO! base module)

function s7BuildConnRequest() {
  // COTP Connection Request (CR-TPDU) — 22 bytes total
  return Buffer.from([
    0x03, 0x00, 0x00, 0x16,                                  // TPKT v3, len=22
    0x11, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x00,                // COTP CR
    0xC0, 0x01, 0x0A,                                        // TPDU size 1024
    0xC1, 0x02, S7_TSAP_SRC[0], S7_TSAP_SRC[1],              // Source TSAP
    0xC2, 0x02, S7_TSAP_DST[0], S7_TSAP_DST[1],              // Dest TSAP
  ]);
}

function s7BuildSetupComm() {
  // S7 SetupCommunication — negotiate PDU size
  return Buffer.from([
    0x03, 0x00, 0x00, 0x19,                                  // TPKT len=25
    0x02, 0xF0, 0x80,                                        // COTP DT
    0x32, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00, 0x08, 0x00, 0x00, // S7 header
    0xF0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0xC0,           // Params: max amq=1/1, PDU=960
  ]);
}

function s7BuildStop() {
  // S7 PLC STOP (function 0x29) — 33 bytes total
  return Buffer.from([
    0x03, 0x00, 0x00, 0x21,                                  // TPKT len=33
    0x02, 0xF0, 0x80,                                        // COTP DT
    0x32, 0x01, 0x00, 0x00, 0x0D, 0x00, 0x00, 0x10, 0x00, 0x00, // S7 header (param len=16)
    0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09,                // STOP function
    0x50, 0x5F, 0x50, 0x52, 0x4F, 0x47, 0x52, 0x41, 0x4D,    // "P_PROGRAM"
  ]);
}

function s7BuildStart() {
  // S7 PLC START / warm start (function 0x28) — 37 bytes total
  return Buffer.from([
    0x03, 0x00, 0x00, 0x25,                                  // TPKT len=37
    0x02, 0xF0, 0x80,                                        // COTP DT
    0x32, 0x01, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x14, 0x00, 0x00, // S7 header (param len=20)
    0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFD, 0x00, 0x00, 0x09, // START function
    0x50, 0x5F, 0x50, 0x52, 0x4F, 0x47, 0x52, 0x41, 0x4D, 0x00, // "P_PROGRAM\0"
  ]);
}

async function s7StopStart(action) {
  if (action !== 'stop' && action !== 'start') throw new Error('action phải là stop hoặc start');

  // Disconnect modbus-serial trước (S7 + Modbus dùng port khác nhưng tránh conflict
  // nếu LOGO! limit total connections).
  const wasConnected = plcConnected;
  plcConnected = false;
  try {
    if (client._port && client._port._client) client._port._client.destroy();
    client.close(() => {});
  } catch {}
  await new Promise(r => setTimeout(r, 300));

  let result;
  try {
    result = await s7Exchange(action);
  } finally {
    setTimeout(() => { if (!plcConnected) connectModbus().catch(() => {}); }, 500);
  }
  return result;
}

function s7Exchange(action) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    let received = Buffer.alloc(0);
    let phase = 'CR';   // CR_SENT → SETUP_SENT → CMD_SENT → DONE
    let settled = false;
    const logs = [];

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { sock.destroy(); } catch {}
      fn(val);
    };
    const timeout = setTimeout(() => finish(reject, new Error(`S7 timeout in phase ${phase}`)), 5000);

    function parseTpktPdu(buf) {
      // Một TPKT PDU: bytes 0-3 = TPKT (03 00 LL LL), rest = COTP + payload
      if (buf.length < 4) return null;
      const len = buf.readUInt16BE(2);
      if (buf.length < len) return null;
      return { pdu: buf.slice(0, len), rest: buf.slice(len) };
    }

    sock.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      while (true) {
        const r = parseTpktPdu(received);
        if (!r) break;
        received = r.rest;
        logs.push(`RX[${phase}] ${r.pdu.length}B: ${r.pdu.toString('hex').toUpperCase().slice(0, 60)}...`);

        if (phase === 'CR') {
          // CC received (COTP type 0xD0). Gửi SetupComm.
          const cotp = r.pdu[5];
          if ((cotp & 0xF0) !== 0xD0) return finish(reject, new Error('S7 CR rejected: ' + r.pdu.toString('hex')));
          phase = 'SETUP';
          const setup = s7BuildSetupComm();
          logs.push(`TX[SETUP] ${setup.length}B`);
          sock.write(setup);
        } else if (phase === 'SETUP') {
          // Setup response received. Gửi command.
          phase = 'CMD';
          const cmd = action === 'stop' ? s7BuildStop() : s7BuildStart();
          logs.push(`TX[${action.toUpperCase()}] ${cmd.length}B`);
          sock.write(cmd);
        } else if (phase === 'CMD') {
          // Response của STOP/START. Check error class (byte 17-18 trong S7 ack_data header).
          phase = 'DONE';
          // S7 ack_data: TPKT(4) + COTP(3) + S7 hdr (ROSCTR=3, redundancy 2, pdu ref 2, param len 2, data len 2, err class 1, err code 1) = 12 bytes header
          // Sau header là params (varies)
          let errClass = null, errCode = null;
          if (r.pdu.length >= 19) {
            errClass = r.pdu[17];
            errCode  = r.pdu[18];
          }
          finish(resolve, {
            ok: errClass === 0,
            action,
            errClass, errCode,
            logs,
            response: r.pdu.toString('hex').toUpperCase().match(/.{2}/g).join(' '),
          });
        }
      }
    });

    sock.on('error', err => {
      let msg = err.message;
      if (err.code === 'ECONNREFUSED') msg = 'PLC từ chối kết nối port 102 (S7 server có thể đã tắt hoặc đang transfer)';
      else if (err.code === 'ECONNRESET') msg = 'PLC reset S7 connection (RST)';
      finish(reject, new Error(msg));
    });
    sock.on('close', () => { if (!settled) finish(reject, new Error(`S7 closed in phase ${phase}`)); });

    sock.connect(S7_PORT, PLC_HOST, () => {
      const cr = s7BuildConnRequest();
      logs.push(`TX[CR] ${cr.length}B`);
      sock.write(cr);
    });
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

  'GET /time': async () => ({
    pcTimeMs: Date.now(),
    pcTimeISO: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    tzOffsetMin: -new Date().getTimezoneOffset(),
  }),

  // Đọc RTC PLC từ VB985..VB990 trong 1 transaction (FC 03 đọc 4 register).
  'GET /rtc': async () => {
    return withModbus(async () => {
      const r = await client.readHoldingRegisters(492, 4);
      const d = r.data;
      const year   = d[0] & 0xFF;          // HR 492 low  = VB985
      const month  = (d[1] >> 8) & 0xFF;   // HR 493 high = VB986
      const day    = d[1] & 0xFF;          // HR 493 low  = VB987
      const hour   = (d[2] >> 8) & 0xFF;   // HR 494 high = VB988
      const minute = d[2] & 0xFF;          // HR 494 low  = VB989
      const second = (d[3] >> 8) & 0xFF;   // HR 495 high = VB990
      return { year, month, day, hour, minute, second };
    });
  },

  // Set toàn bộ RTC bằng 5 lần FC06 RMW (Year/Month/Day/Hour/Minute).
  // Mỗi byte VB985-VB989 viết riêng qua FC03 + FC06, delay 200ms giữa các write.
  // Đây là cách an toàn nhất đã verify: FC06 single byte không crash PLC.
  'POST /set-clock': async (req) => {
    const now = Date.now();
    const sinceLast = now - lastTestRtcWriteTs;
    if (sinceLast < TEST_RTC_COOLDOWN_MS) {
      const wait = Math.ceil((TEST_RTC_COOLDOWN_MS - sinceLast) / 1000);
      throw new Error(`Cooldown ${wait}s — đợi rồi thử lại.`);
    }
    if (req.headers['x-confirm-backup'] !== 'yes') {
      throw new Error('Header X-Confirm-Backup: yes bắt buộc');
    }
    const b = await readBody(req);
    const fields = {
      VB985: { value: b.year   | 0, label: 'Year'   },
      VB986: { value: b.month  | 0, label: 'Month'  },
      VB987: { value: b.day    | 0, label: 'Day'    },
      VB988: { value: b.hour   | 0, label: 'Hour'   },
      VB989: { value: b.minute | 0, label: 'Minute' },
    };
    for (const [vb, info] of Object.entries(fields)) {
      if (info.value < 0 || info.value > 255) throw new Error(`${vb} (${info.label}) ngoài range 0-255`);
    }
    lastTestRtcWriteTs = now;
    console.warn('[set-clock] FC06 RMW 5 byte:', JSON.stringify(b));

    return withModbus(async () => {
      // 1. Read HR 492-495 trước để chụp baseline
      const before = (await client.readHoldingRegisters(492, 4)).data;

      // 2. Write từng VB qua FC06 RMW. Mỗi lần đọc HR mới rồi modify byte cần thay.
      const writes = [
        { vb: 985, value: fields.VB985.value },
        { vb: 986, value: fields.VB986.value },
        { vb: 987, value: fields.VB987.value },
        { vb: 988, value: fields.VB988.value },
        { vb: 989, value: fields.VB989.value },
      ];
      const log = [];
      for (const w of writes) {
        const hrAddr = Math.floor(w.vb / 2);
        const byteOffset = w.vb % 2;
        const r = await client.readHoldingRegisters(hrAddr, 1);
        const cur = r.data[0];
        const next = byteOffset === 0
          ? ((w.value & 0xFF) << 8) | (cur & 0x00FF)
          : (cur & 0xFF00) | (w.value & 0xFF);
        await client.writeRegister(hrAddr, next);
        log.push({ vb: w.vb, value: w.value, hr: hrAddr,
                   before: '0x' + cur.toString(16).padStart(4,'0').toUpperCase(),
                   after:  '0x' + next.toString(16).padStart(4,'0').toUpperCase() });
        await new Promise(r => setTimeout(r, 200));
      }

      // 3. Readback toàn vùng RTC sau write
      await new Promise(r => setTimeout(r, 300));
      const after = (await client.readHoldingRegisters(492, 4)).data;

      return {
        ok: true,
        writes: log,
        before: {
          VB984: (before[0] >> 8) & 0xFF, VB985: before[0] & 0xFF,
          VB986: (before[1] >> 8) & 0xFF, VB987: before[1] & 0xFF,
          VB988: (before[2] >> 8) & 0xFF, VB989: before[2] & 0xFF,
          VB990: (before[3] >> 8) & 0xFF, VB991: before[3] & 0xFF,
        },
        after: {
          VB984: (after[0] >> 8) & 0xFF, VB985: after[0] & 0xFF,
          VB986: (after[1] >> 8) & 0xFF, VB987: after[1] & 0xFF,
          VB988: (after[2] >> 8) & 0xFF, VB989: after[2] & 0xFF,
          VB990: (after[3] >> 8) & 0xFF, VB991: after[3] & 0xFF,
        },
      };
    });
  },

  // STOP PLC qua S7 protocol (TCP 102). LOGO! 8 hỗ trợ S7 connection.
  // Flow: TCP connect → COTP CR/CC → S7 SetupComm → S7 STOP (0x29) → close.
  'POST /plc-stop':  async () => s7StopStart('stop'),

  // START PLC qua S7 (function 0x28 = warm start).
  'POST /plc-start': async () => s7StopStart('start'),

  // Gửi raw Modbus TCP frame. Strategy: tạm disconnect modbus-serial, mở
  // socket riêng để send/receive, đóng, reconnect modbus-serial.
  // → Tránh: TID collision với modbus-serial parser, LOGO! 8-conn limit.
  // → Trade-off: polling pause ~1-2 giây cho mỗi raw frame call.
  'POST /raw-frame': async (req) => {
    const body = await readBody(req);
    if (typeof body.hex !== 'string') throw new Error('Thiếu hex string');
    const cleaned = body.hex.replace(/[\s,:-]/g, '');
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('Hex string không hợp lệ');
    if (cleaned.length % 2 !== 0) throw new Error('Hex string phải chẵn ký tự');
    const frame = Buffer.from(cleaned, 'hex');
    if (frame.length < 8) throw new Error('Frame quá ngắn (cần >= 8 byte MBAP+FC)');
    if (frame.length > 260) throw new Error('Frame quá dài (>260 byte)');

    console.warn('[raw-frame] gửi:', frame.toString('hex').toUpperCase().match(/.{2}/g).join(' '));

    // Đi qua withModbus queue để block polling trong lúc disconnect/reconnect
    return withModbus(async () => {
      // 1. Disconnect modbus-serial tạm thời
      const wasConnected = plcConnected;
      plcConnected = false;
      try {
        if (client._port && client._port._client) {
          client._port._client.destroy();
        }
        client.close(() => {});
      } catch {}
      await new Promise(r => setTimeout(r, 400));  // đợi LOGO! release slot

      // 2. Mở socket dedicated, gửi frame, đọc response
      const result = await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setNoDelay(true);
        let received = Buffer.alloc(0);
        let settled = false;
        const t0 = Date.now();
        const finish = (fn, val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try { sock.destroy(); } catch {}
          fn(val);
        };
        const timeout = setTimeout(
          () => finish(reject, new Error(`Timeout 3s (nhận ${received.length} byte)`)),
          3000
        );

        sock.on('data', chunk => {
          received = Buffer.concat([received, chunk]);
          if (received.length >= 6) {
            const expectedTotal = 6 + received.readUInt16BE(4);
            if (received.length >= expectedTotal) {
              const elapsed = Date.now() - t0;
              finish(resolve, {
                ok: true,
                elapsedMs: elapsed,
                sent:     { hex: frame.toString('hex').toUpperCase().match(/.{2}/g).join(' '), len: frame.length },
                received: { hex: received.slice(0, expectedTotal).toString('hex').toUpperCase().match(/.{2}/g).join(' '), len: expectedTotal },
              });
            }
          }
        });
        sock.on('error', err => {
          let msg = err.message;
          if (err.code === 'ECONNRESET') msg = 'PLC reset connection (RST) — có thể bị quá tải hoặc firmware bug';
          else if (err.code === 'ECONNREFUSED') msg = 'PLC refused — Modbus Slave disabled hoặc max connections';
          finish(reject, new Error(msg));
        });
        sock.on('close', () => {
          if (!settled) finish(reject, new Error(`Connection đóng sau ${received.length} byte (PLC FIN)`));
        });
        sock.connect(PLC_PORT, PLC_HOST, () => {
          // Đợi 30ms cho TCP handshake settle trước khi gửi frame
          setTimeout(() => { try { sock.write(frame); } catch (e) { finish(reject, e); } }, 30);
        });
      }).catch(e => ({ ok: false, error: e.message }));

      // 3. Reconnect modbus-serial (best effort, không block response)
      setTimeout(() => {
        if (!plcConnected) connectModbus().catch(() => {});
      }, 300);

      if (!result.ok) throw new Error(result.error);
      return result;
    });
  },

  // 🔥 DESTRUCTIVE FC16 test — reproduce frame mà AI hướng dẫn:
  //   00 01 00 00 00 0D 01 10 01 EC 00 04 08 YY MM DD HH MN SS XX
  // Đã wipe program 2 lần trong session 2026-05-19. Add lại theo yêu cầu user.
  // Safety: 5-minute cooldown + 2 header confirm + read body confirm token.
  'POST /test-fc16-rtc-DESTRUCTIVE': async (req) => {
    const now = Date.now();
    const sinceLast = now - lastFc16TestTs;
    if (sinceLast < FC16_TEST_COOLDOWN_MS) {
      const wait = Math.ceil((FC16_TEST_COOLDOWN_MS - sinceLast) / 1000);
      throw new Error(`Cooldown ${wait}s — frame này wipe program 2 lần rồi.`);
    }
    if (req.headers['x-confirm-backup'] !== 'yes' || req.headers['x-confirm-destructive'] !== 'WIPE-RISK') {
      throw new Error('Cần X-Confirm-Backup: yes + X-Confirm-Destructive: WIPE-RISK headers');
    }
    const b = await readBody(req);
    if (b.confirmToken !== 'I-UNDERSTAND-WIPE-RISK') {
      throw new Error('Cần confirmToken="I-UNDERSTAND-WIPE-RISK" trong body');
    }
    const yr = (b.year   | 0) & 0xFF;
    const mo = (b.month  | 0) & 0xFF;
    const dy = (b.day    | 0) & 0xFF;
    const hr = (b.hour   | 0) & 0xFF;
    const mn = (b.minute | 0) & 0xFF;
    const sc = (b.second | 0) & 0xFF;
    lastFc16TestTs = now;
    console.warn('🔥🔥🔥 [DESTRUCTIVE FC16] Sending wipe-risk frame to HR 492-495 🔥🔥🔥');
    console.warn(`  Y=${yr} M=${mo} D=${dy} H=${hr} Mn=${mn} S=${sc}`);

    return withModbus(async () => {
      // Đọc HR 495 trước để preserve VB991 trong byte thấp của HR 495.
      const r495before = await client.readHoldingRegisters(495, 1);
      // Build 4 registers giống frame AI:
      //   HR 492 = (00 << 8) | year  ← VB984 zero, VB985 year
      //   HR 493 = (month << 8) | day
      //   HR 494 = (hour << 8) | minute
      //   HR 495 = (second << 8) | preserved
      const newData = [
        yr,                                          // HR 492: VB984=0 + VB985=year
        (mo << 8) | dy,                              // HR 493
        (hr << 8) | mn,                              // HR 494
        (sc << 8) | (r495before.data[0] & 0xFF),     // HR 495: VB990=second + preserved VB991
      ];
      await client.writeRegisters(492, newData);
      return { ok: true, written: newData.map(x => '0x' + x.toString(16).padStart(4,'0').toUpperCase()) };
    });
  },

  // ⚠️ EXPERIMENTAL: test FC06 write 1 VB byte trong RTC area via RMW
  // (FC03 read + FC06 write). Rate limit + backup confirm bắt buộc.
  'POST /test-vb-write': async (req) => {
    const now = Date.now();
    const sinceLast = now - lastTestRtcWriteTs;
    if (sinceLast < TEST_RTC_COOLDOWN_MS) {
      const wait = Math.ceil((TEST_RTC_COOLDOWN_MS - sinceLast) / 1000);
      throw new Error(`Cooldown ${wait}s — đề phòng 3-strike wipe.`);
    }
    if (req.headers['x-confirm-backup'] !== 'yes') {
      throw new Error('Header X-Confirm-Backup: yes bắt buộc');
    }
    const { vb, value } = await readBody(req);
    if (!Number.isInteger(vb) || vb < 984 || vb > 990) {
      throw new Error('vb phải là 984..990');
    }
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('value phải là 0..255');
    }
    lastTestRtcWriteTs = now;
    const hrAddr = Math.floor(vb / 2);
    const byteOffset = vb % 2;   // 0 = high byte (VB chẵn), 1 = low byte
    console.warn(`[EXPERIMENTAL] VB${vb} = ${value} (HR ${hrAddr} ${byteOffset === 0 ? 'high' : 'low'} byte)`);
    return withModbus(async () => {
      // Read-modify-write
      const r = await client.readHoldingRegisters(hrAddr, 1);
      const cur = r.data[0];
      const next = byteOffset === 0
        ? ((value & 0xFF) << 8) | (cur & 0x00FF)
        : (cur & 0xFF00) | (value & 0xFF);
      await client.writeRegister(hrAddr, next);
      // Readback HR 492-495 để biết toàn cảnh RTC sau write
      await new Promise(r => setTimeout(r, 300));
      const v = await client.readHoldingRegisters(492, 4);
      return {
        ok: true,
        wrote: {
          vb, value,
          hrAddr,
          regBefore: '0x' + cur.toString(16).padStart(4, '0').toUpperCase(),
          regAfter:  '0x' + next.toString(16).padStart(4, '0').toUpperCase(),
        },
        readback: {
          VB984: (v.data[0] >> 8) & 0xFF, VB985: v.data[0] & 0xFF,
          VB986: (v.data[1] >> 8) & 0xFF, VB987: v.data[1] & 0xFF,
          VB988: (v.data[2] >> 8) & 0xFF, VB989: v.data[2] & 0xFF,
          VB990: (v.data[3] >> 8) & 0xFF, VB991: v.data[3] & 0xFF,
        },
      };
    });
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
  // Auto-list từ routes object để không bao giờ outdate
  console.log(`[http] endpoints:`);
  for (const key of Object.keys(routes)) console.log(`         ${key}`);
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
