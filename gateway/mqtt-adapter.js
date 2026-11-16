'use strict';
/**
 * Bộ chuyển MQTT cho gateway (mqtt.js 5). Topic theo tủ:
 *   lvc/<id>/state   gateway → server  (QoS 0, retain)     trạng thái
 *   lvc/<id>/ack     gateway → server  (QoS 1)             kết quả lệnh
 *   lvc/<id>/online  gateway → server  (QoS 1, retain, LWT) "1" / "0"
 *   lvc/<id>/cmd     server  → gateway (QoS 1, KHÔNG retain) lệnh
 *   lvc/<id>/config  server  → gateway (QoS 1, retain)      lịch
 * clean session = true (không nhận lại lệnh cũ sau khi rớt kết nối; chống phát lại thêm bằng seq/expiresAt).
 */
const mqtt = require('mqtt');

const STATION_RE = /^[A-Z0-9-]{1,32}$/;

function createMqttAdapter({ url, stationId, key, log = () => {}, connectFn = mqtt.connect }) {
  if (!STATION_RE.test(stationId)) throw new Error('stationId không hợp lệ');
  const t = s => `lvc/${stationId}/${s}`;
  const handlers = { cmd: () => {}, config: () => {} };
  const client = connectFn(url, {
    clientId: `gw-${stationId}`, username: stationId, password: key, clean: true, keepalive: 30,
    reconnectPeriod: 5000, connectTimeout: 15000, protocolVersion: 4,
    will: { topic: t('online'), payload: '0', qos: 1, retain: true },
  });
  client.on('connect', () => {
    log('mqtt connected');
    client.publish(t('online'), '1', { qos: 1, retain: true });
    client.subscribe([t('cmd'), t('config')], { qos: 1 });
  });
  client.on('error', e => log('mqtt error', e.message));
  client.on('message', (topic, buf) => {
    let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (topic === t('cmd')) handlers.cmd(msg);
    else if (topic === t('config')) handlers.config(msg);
  });
  return {
    client,
    get connected() { return client.connected; },
    onCommand(f) { handlers.cmd = f; },
    onConfig(f) { handlers.config = f; },
    publishState(s) { if (client.connected) client.publish(t('state'), JSON.stringify(s), { qos: 0, retain: true }); },
    publishAck(a) { client.publish(t('ack'), JSON.stringify(a), { qos: 1 }); },   // mqtt.js tự xếp hàng khi đang mất kết nối
    end() { return new Promise(r => client.end(false, {}, r)); },
  };
}

module.exports = { createMqttAdapter, STATION_RE };
