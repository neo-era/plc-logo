/**
 * PLC Gateway — chạy trên Raspberry Pi tại mỗi trạm.
 *
 *   PLC LOGO! 230RCE  ⇄ Modbus TCP ⇄  gateway.js  ⇄ MQTT(TLS) ⇄  server trung tâm
 *
 * Trách nhiệm:
 *   - Poll PLC định kỳ → publish trạng thái lên topic dentat/<stationId>/state
 *   - Subscribe topic dentat/<stationId>/cmd → thực thi ghi PLC
 *   - Last Will Testament → server biết khi gateway offline
 *   - Reconnect tự động (MQTT + Modbus đều có retry)
 *   - Store-and-forward khi mất MQTT: buffer last N state để gửi lại
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ModbusRTU = require('modbus-serial');
const mqtt = require('mqtt');

// ── CONFIG ──────────────────────────────────────────────────────────
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[gateway] Thiếu config.json — copy từ config.example.json');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const STATION = cfg.stationId;
const TOPIC = {
  state:  `dentat/${STATION}/state`,
  cmd:    `dentat/${STATION}/cmd`,
  ack:    `dentat/${STATION}/ack`,
  online: `dentat/${STATION}/online`,
};

// ── MODBUS MAPPING LOGO! ↔ Modbus address ──────────────────────────
//   Chuẩn Siemens cho LOGO! 8 Modbus Slave.
function logoToModbus(addr) {
  const m = String(addr).trim().match(/^([IQMAV][BIWDQ]?)(\d+)$/i);
  if (!m) throw new Error('Địa chỉ LOGO! không hợp lệ: ' + addr);
  const area = m[1].toUpperCase();
  const num = parseInt(m[2]);
  if (area === 'I')  return { type: 'discrete', address: num - 1 };          // I1 → DI 0
  if (area === 'Q')  return { type: 'coil',     address: 8192 + (num - 1) }; // Q1 → Coil 8192
  if (area === 'M')  return { type: 'coil',     address: 8256 + (num - 1) }; // M1 → Coil 8256
  if (area === 'AI') return { type: 'input',    address: num };              // AI1 → IR 1
  if (area === 'AQ') return { type: 'holding',  address: 512 + num };        // AQ1 → HR 513
  if (area === 'VW') return { type: 'holding',  address: num / 2 };          // VW0 → HR 0, VW2 → HR 1
  if (area === 'VB') return { type: 'holding',  address: Math.floor(num/2), highByte: num % 2 === 0 };
  if (area === 'VD') return { type: 'holding',  address: num / 2, dword: true };
  throw new Error('Vùng nhớ chưa hỗ trợ: ' + area);
}

// ── MODBUS CLIENT ──────────────────────────────────────────────────
const modbus = new ModbusRTU();
modbus.setID(cfg.plc.slaveId || 1);
modbus.setTimeout(cfg.plc.timeoutMs || 3000);
let modbusConnected = false;

async function connectModbus() {
  if (modbusConnected) return;
  try {
    await modbus.connectTCP(cfg.plc.host, { port: cfg.plc.port || 502 });
    modbusConnected = true;
    console.log(`[modbus] Đã kết nối PLC ${cfg.plc.host}:${cfg.plc.port}`);
  } catch (e) {
    modbusConnected = false;
    console.warn('[modbus] Kết nối thất bại:', e.message);
    setTimeout(connectModbus, 5000);
  }
}
modbus.on('close', () => { modbusConnected = false; console.warn('[modbus] Mất kết nối — thử lại sau 5s'); setTimeout(connectModbus, 5000); });

async function readPoint(addr, type) {
  const m = logoToModbus(addr);
  if (m.type === 'discrete') {
    const r = await modbus.readDiscreteInputs(m.address, 1);
    return r.data[0];
  }
  if (m.type === 'coil') {
    const r = await modbus.readCoils(m.address, 1);
    return r.data[0];
  }
  if (m.type === 'input') {
    const r = await modbus.readInputRegisters(m.address, 1);
    return r.data[0];
  }
  if (m.type === 'holding') {
    const len = m.dword ? 2 : 1;
    const r = await modbus.readHoldingRegisters(m.address, len);
    if (m.dword) return (r.data[0] << 16) | r.data[1];
    return r.data[0];
  }
  throw new Error('Không đọc được: ' + addr);
}

async function writePoint(addr, value) {
  const m = logoToModbus(addr);
  if (m.type === 'coil') {
    await modbus.writeCoil(m.address, !!value);
    return true;
  }
  if (m.type === 'holding') {
    if (m.dword) {
      const hi = (value >> 16) & 0xFFFF, lo = value & 0xFFFF;
      await modbus.writeRegisters(m.address, [hi, lo]);
    } else {
      await modbus.writeRegister(m.address, value & 0xFFFF);
    }
    return true;
  }
  if (m.type === 'discrete' || m.type === 'input') {
    throw new Error('Vùng chỉ đọc: ' + addr);
  }
  throw new Error('Không ghi được: ' + addr);
}

// ── POLL LOOP ──────────────────────────────────────────────────────
const buffer = []; // store-and-forward khi mất MQTT
const MAX_BUFFER = 200;

async function pollOnce() {
  if (!modbusConnected) { await connectModbus(); return; }
  const sample = { ts: Date.now(), stationId: STATION, I:{}, Q:{}, M:{}, V:{} };
  const all = [
    ...cfg.points.inputs.map(p  => ({ area:'I', ...p })),
    ...cfg.points.outputs.map(p => ({ area:'Q', ...p })),
    ...cfg.points.memory.map(p  => ({ area:'M', ...p })),
    ...cfg.points.variables.map(p => ({ area:'V', ...p })),
  ];
  for (const pt of all) {
    try {
      const v = await readPoint(pt.addr, pt.type);
      sample[pt.area][pt.addr] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    } catch (e) {
      console.warn(`[poll] Lỗi đọc ${pt.addr}: ${e.message}`);
    }
  }
  publishState(sample);
}

function publishState(sample) {
  if (!mqttClient || !mqttClient.connected) {
    buffer.push(sample);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    return;
  }
  // gửi state hiện tại với retain=true để client mới connect biết ngay
  mqttClient.publish(TOPIC.state, JSON.stringify(sample), { qos: 1, retain: true });

  // gửi nốt buffer dồn lại (không retain) → server append vào history
  while (buffer.length) {
    const old = buffer.shift();
    mqttClient.publish(TOPIC.state + '/history', JSON.stringify(old), { qos: 1 });
  }
}

// ── MQTT CLIENT ────────────────────────────────────────────────────
let mqttClient = null;

function connectMqtt() {
  mqttClient = mqtt.connect(cfg.mqtt.url, {
    clientId: 'gw-' + STATION + '-' + Math.random().toString(16).slice(2, 8),
    username: cfg.mqtt.username,
    password: cfg.mqtt.password,
    rejectUnauthorized: cfg.mqtt.rejectUnauthorized !== false,
    reconnectPeriod: 5000,
    keepalive: 30,
    will: {
      topic: TOPIC.online,
      payload: JSON.stringify({ stationId: STATION, online: false, ts: Date.now() }),
      qos: 1, retain: true,
    },
  });

  mqttClient.on('connect', () => {
    console.log(`[mqtt] Đã kết nối ${cfg.mqtt.url}`);
    mqttClient.publish(TOPIC.online, JSON.stringify({ stationId: STATION, online: true, ts: Date.now(), name: cfg.stationName }), { qos: 1, retain: true });
    mqttClient.subscribe(TOPIC.cmd, { qos: 1 });
  });
  mqttClient.on('reconnect', () => console.log('[mqtt] Đang reconnect...'));
  mqttClient.on('close',     () => console.warn('[mqtt] Mất kết nối'));
  mqttClient.on('error',     e => console.error('[mqtt] Lỗi:', e.message));

  mqttClient.on('message', async (topic, payload) => {
    if (topic !== TOPIC.cmd) return;
    let cmd;
    try { cmd = JSON.parse(payload.toString()); } catch { return; }
    // cmd = { id, addr, value, ts, by }
    const ack = { id: cmd.id, addr: cmd.addr, ts: Date.now(), ok: false };
    try {
      await writePoint(cmd.addr, cmd.value);
      ack.ok = true;
      console.log(`[cmd] ${cmd.addr} = ${cmd.value} (by ${cmd.by || '?'})`);
    } catch (e) {
      ack.error = e.message;
      console.warn(`[cmd] Thất bại ${cmd.addr}: ${e.message}`);
    }
    mqttClient.publish(TOPIC.ack, JSON.stringify(ack), { qos: 1 });
    // poll ngay để state mới đẩy về server không phải đợi chu kỳ tiếp
    pollOnce().catch(()=>{});
  });
}

// ── MAIN ───────────────────────────────────────────────────────────
async function main() {
  console.log(`[gateway] Khởi động trạm ${STATION} (${cfg.stationName || ''})`);
  connectMqtt();
  await connectModbus();
  setInterval(() => { pollOnce().catch(e => console.warn('[poll]', e.message)); }, cfg.plc.pollMs || 2000);
}

main().catch(e => { console.error('[gateway] Crash:', e); process.exit(1); });

// graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => {
  console.log('[gateway] Dừng...');
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(TOPIC.online, JSON.stringify({ stationId: STATION, online: false, ts: Date.now() }), { qos: 1, retain: true });
    mqttClient.end(false, {}, () => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  } else process.exit(0);
}));
