'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  for (const f of fs.readdirSync(path.join(__dirname, '../db')).filter(f => f.endsWith('.sql')).sort()) {
    await c.query(fs.readFileSync(path.join(__dirname, '../db', f), 'utf8')); console.log('applied', f);
  }
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
