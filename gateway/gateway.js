#!/usr/bin/env node
'use strict';
/**
 * Chương trình gateway chạy tại tủ (Raspberry Pi / máy công nghiệp, Linux).
 * Cấu hình qua biến môi trường (file /etc/plc-gateway.env, quyền 600):
 *   STATION_ID=LVC02  GATEWAY_KEY=<khoá ≥ 128 bit do server cấp>
 *   MQTT_URL=wss://api.lavipco.vn/mqtt   PLC_HOST=192.168.0.3   PLC_PORT=502
 *   STATE_FILE=/var/lib/plc-gateway/state.json
 */
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const { Gateway } = require('./agent');
const { ModbusClient } = require('./modbus-client');
const { createMqttAdapter } = require('./mqtt-adapter');
const { fileStore } = require('./file-store');

const env = k => { const v = process.env[k]; if (!v) { console.error(`Thiếu biến môi trường ${k}`); process.exit(2); } return v; };
const log = (...a) => console.log(new Date().toISOString(), ...a);

function ntpSynced() {
  try { return execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 2000 }).toString().trim() === 'yes'; }
  catch { return false; }
}
let ntpCache = { at: 0, v: false };
const ntpCached = () => { if (Date.now() - ntpCache.at > 30000) ntpCache = { at: Date.now(), v: ntpSynced() }; return ntpCache.v; };

function tempC() {
  try { return Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000); } catch { return null; }
}

function main() {
  const stationId = env('STATION_ID');
  const mqtt = createMqttAdapter({ url: env('MQTT_URL'), stationId, key: env('GATEWAY_KEY'), log });
  const modbus = new ModbusClient({ host: process.env.PLC_HOST || '192.168.0.3', port: Number(process.env.PLC_PORT || 502), timeoutMs: 2000 });
  const store = fileStore(process.env.STATE_FILE || '/var/lib/plc-gateway/state.json');
  const gw = new Gateway({ stationId, clock: Date.now, modbus, mqtt, store, ntpSynced: ntpCached, tempC, log });

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await gw.tick(); } catch (e) { log('tick error', e.message); } finally { busy = false; }
  }, 1000);
  // watchdog systemd (Type=notify, WatchdogSec=60): báo sống mỗi 15 s khi vòng lặp còn chạy
  let lastTickOk = Date.now();
  const origTick = gw.tick.bind(gw);
  gw.tick = async () => { await origTick(); lastTickOk = Date.now(); };
  // --pid: gán tin cho đúng tiến trình chính (tránh race PID của tiến trình con systemd-notify)
  const notify = msg => { if (process.env.NOTIFY_SOCKET) execFile('systemd-notify', [`--pid=${process.pid}`, msg], () => {}); };
  notify('READY=1');
  setInterval(() => { if (Date.now() - lastTickOk < 30000) notify('WATCHDOG=1'); }, 15000);

  const stop = async () => { clearInterval(timer); modbus.close(); await mqtt.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  log(`gateway ${stationId} khởi động`);
}

if (require.main === module) main();
