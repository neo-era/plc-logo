'use strict';
/** Khởi động dịch vụ plc. Biến môi trường: DATABASE_URL, JWT_SECRET (chung với core), ZALO_BOT_TOKEN, ZALO_WEBHOOK_SECRET, ALLOWED_ORIGINS, PORT. */
const { Pool } = require('pg');
const { createBroker } = require('./broker');
const { createService } = require('./service');
const { buildApp } = require('./app');
const { createZalo } = require('./zalo');

const need = k => { const v = process.env[k]; if (!v) { console.error(`Thiếu biến môi trường ${k} — dừng`); process.exit(2); } return v; };
const log = (...a) => console.log(new Date().toISOString(), ...a);

process.on('unhandledRejection', e => log('unhandledRejection', e && e.message));
process.on('uncaughtException', e => { log('uncaughtException — thoát để Docker khởi động lại', e && e.stack); process.exit(1); });
const trustedProxies = (process.env.TRUSTED_PROXIES || '172.30.0.2').split(',').map(s => s.trim());

async function start() {
  const jwtSecret = need('JWT_SECRET');
  if (jwtSecret.length < 32) { console.error('JWT_SECRET quá ngắn — dừng'); process.exit(2); }
  const db = new Pool({ connectionString: need('DATABASE_URL'), max: 10 });
  let brokerRef;
  const service = createService({ db, publish: (t, o, opt) => brokerRef.publish(t, o, opt), zalo: createZalo({ token: process.env.ZALO_BOT_TOKEN }), log });
  brokerRef = await createBroker({
    getStation: id => service.getStation(id), log, trustedProxies,
    onState: (id, s) => service.onState(id, s).catch(e => log('state', e.message)),
    onAck: (id, a) => service.onAck(id, a).catch(e => log('ack', e.message)),
    onHist: (id, m) => service.onHist(id, m).catch(e => log('hist', e.message)),
    onOnline: (id, o) => service.onOnline(id, o).catch(e => log('online', e.message)),
  });
  const app = buildApp({ service, broker: brokerRef, db, jwtSecret, log, trustedProxies,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://neo-era.github.io').split(',').map(s => s.trim()),
    zaloWebhookSecret: process.env.ZALO_WEBHOOK_SECRET || null });
  const sweep = setInterval(() => service.sweep().catch(e => log('sweep', e.message)), 30e3);
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3100) });
  log('plc service listening');
  const stop = async () => { clearInterval(sweep); await app.close(); await brokerRef.close(); await db.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
start().catch(e => { console.error(e); process.exit(1); });
