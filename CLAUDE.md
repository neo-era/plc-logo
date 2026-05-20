# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

Toolkit for controlling and monitoring Siemens **LOGO! 230RCE (0BA8+)** PLCs from the web. There are **four independently deployable components**, each with its own `package.json`/`node_modules`. They are not a monorepo — there is no top-level `package.json` and no shared deps.

| Component | Path | Role |
|-----------|------|------|
| Standalone HMI | `index.html` | Single-page browser UI for one PC + one PLC. Has 3 connection modes (Demo / Modbus Local Proxy / LOGO! Web). 2,500+ lines, no build step. |
| Local Modbus proxy | `local-proxy/proxy.js` | Node HTTP server on `127.0.0.1:3001` that bridges browser ↔ Modbus TCP for `index.html`. Includes S7-protocol PLC stop/start, RTC sync, NTP server, raw-frame send, SSE push, frame tap. ~1,200 lines. |
| Distributed gateway | `gateway/gateway.js` | Runs on a Raspberry Pi at each station. Polls PLC via Modbus, publishes state over MQTT/TLS to the central server, subscribes to write commands. |
| Central server | `server/server.js` | Single Node process bundling an **Aedes MQTT broker** + Express REST + WebSocket + SQLite (better-sqlite3) + JWT auth, serving the multi-station UI at `server/public/plc.html`. |

Documentation, comments, and log messages are written **in Vietnamese**. Match that style when editing.

## Common commands

There is **no test suite, no linter, and no build step** in this repo. Everything runs directly with `node`.

```bash
# Local proxy (PC + 1 PLC scenario)
cd local-proxy && npm install
node proxy.js --plc-host 192.168.0.3                 # default port 3001, NTP on UDP 123
node proxy.js --plc-host 192.168.0.3 --no-ntp        # if W32Time holds port 123

# Gateway (per-station, on Raspberry Pi)
cd gateway && npm install
cp config.example.json config.json                    # paste stationId + gatewayToken
node gateway.js                                       # CONFIG_PATH env var overrides path
# systemd unit at gateway/systemd/plc-gateway.service

# Central server — preferred via Docker
cp server/.env.example server/.env                    # MUST change JWT_SECRET and ADMIN_PASS
docker compose up -d                                  # exposes :8080 (HTTP+WS), :1883, :8883
docker compose logs -f server

# Server without Docker (dev)
cd server && npm install
npm run dev    # node --watch server.js
npm start      # node server.js

# Standalone HMI (no server needed)
# Just open index.html in a browser. Configure mode in ⚙ Cài đặt.
```

The server seeds an admin user on first boot from `ADMIN_USER` / `ADMIN_PASS` in `.env`. SQLite DB is created at `DB_PATH` (default `./data/plc.db`, mounted to `./server/data` via docker-compose).

## Architecture — the big picture

### Two distinct UIs, easy to confuse

- **`/index.html` (root)** — the **standalone** UI. Targets `local-proxy` directly or the PLC's built-in Siemens web. ~134 KB, used in scenario A (1 PC + 1 PLC).
- **`/server/public/plc.html`** — the **multi-station** UI served by the central server. Talks to REST + WS, never directly to a PLC. ~30 KB. Has login, station grid, admin tab.

They look similar but have **different feature sets** and **different backends**. Do not assume a change to one applies to the other — check both files.

### Two implementations of the LOGO!↔Modbus mapping

The mapping from LOGO! addresses (`I1`, `Q1`, `VW0`, `NI1`, `V0.0`...) to Modbus addresses lives in **two places**:

- `local-proxy/proxy.js` — `logoToModbus()` at line ~52. **Richer**: supports `NI/NQ/NAI/NAQ`, `V<n>.<m>` bit addressing, `VB` byte addressing, `VD` dword.
- `gateway/gateway.js` — `logoToModbus()` at line ~37. **Simpler**: only `I/Q/M/AI/AQ/VW/VB/VD`. No `NI/NQ/NAI/NAQ`, no V-bit.

If you add support for a new area type, update both. The full address table is in `README.md` and `local-proxy/README.md`.

### Multi-station data flow (scenario B)

```
LOGO! PLC ──Modbus TCP──▶ gateway.js ──MQTT/TLS──▶ Aedes broker (in server.js)
                                                    │
                                                    │ internal MQTT client (loopback, INTERNAL_SECRET)
                                                    ▼
                                                  SQLite + WebSocket fanout
                                                    │
                                                    ▼
                                            Browser (plc.html) over WS
```

MQTT topic namespace is **`dentat/<stationId>/{state,state/history,cmd,ack,online}`**. Aedes' `authorizePublish`/`authorizeSubscribe` enforces that a gateway authenticated as station `X` can only touch topics under `dentat/X/`. The server's own internal MQTT client uses `username=INTERNAL` + a per-boot random `INTERNAL_SECRET` (RAM-only) to bypass the namespace check.

Key topic semantics:
- `state` is published with `retain: true` so a reconnecting consumer immediately gets the latest snapshot.
- `online` uses both retained publish **and** MQTT Last Will Testament. If the gateway dies, the broker auto-publishes `online: false` — no heartbeat timeout needed.
- `state/history` is the store-and-forward channel: when the gateway loses MQTT, it buffers up to 200 samples in RAM (`MAX_BUFFER` in `gateway.js`) and flushes them as `state/history` (non-retained) on reconnect → server appends to the `history` table.

Auth model:
- **Users** (`role` = `admin` or `operator`): bcrypt hash, JWT 7-day. Only admin creates/deletes stations.
- **Gateways**: when admin creates a station, a 24-byte hex token is generated. The bcrypt hash is stored; **the plaintext is returned exactly once** in the POST `/api/stations` response. Re-issuing requires deleting + recreating the station.
- Gateway MQTT credentials: `username = stationId`, `password = gatewayToken`.

REST API and DB schema are documented in `docs/architecture.md` — keep that file in sync if you add endpoints or columns.

### Local-proxy: more than a Modbus bridge

The local-proxy is not just an HTTP→Modbus translator. It also implements:
- **S7 protocol over TCP 102** for PLC Stop/Start (FC 0x29/0x28) and full RTC set (UserData 0x47.02, BCD-encoded). The Modbus FC06 path cannot reliably set the LOGO! year (see below) — S7 is the workaround.
- **NTP server on UDP 123** so the LOGO! can sync RTC from the PC without external internet.
- **SSE push** (`GET /events`) plus a server-side background poller (5s interval). UI calls `POST /subscribe` once with its point list; the proxy then pushes only changes via SSE. This replaced an older 1.5s polling loop.
- **Frame tap** — wraps the underlying socket to record raw Modbus TX/RX bytes for `/frames` (debugging UI).
- **Raw-frame injection** (`POST /raw-frame`) — temporarily disconnects modbus-serial, opens a dedicated socket, sends arbitrary bytes, then reconnects. Required to avoid TID collision and LOGO!'s 8-connection limit.

The route table is a plain `routes` object at the bottom of `proxy.js`; adding a route = adding a `'METHOD /path': async (req) => {...}` entry. The server logs all routes on startup, so the list stays self-documenting.

### Modbus connection quirks (important when touching `proxy.js` or `gateway.js`)

- `modbus-serial` allows only **one in-flight transaction per socket**. The local-proxy serializes everything through `withModbus(fn)` (a promise queue). If you add a new endpoint that touches Modbus, wrap it in `withModbus`.
- `modbus-serial` does **not** always destroy half-open sockets on reconnect. LOGO! caps connections at 8 — leak enough sockets and the PLC stops accepting. The reconnect path in `connectModbus()` explicitly calls `client._port._client.destroy()` before retrying. Preserve that.
- `isConnectionLost(err)` deliberately treats `"Timed out"` as **non-fatal** — only `Port Not Open`, `ECONNRESET`, `EPIPE` trigger a reconnect. A slow op should not tear down the socket and kill subsequent ops.

### LOGO! RTC: only HR 493/494 are writable via Modbus

Empirically verified on LOGO! 0BA8: writing to **HR 492** (which contains VB984 Diagnostic + VB985 Year) is silently dropped by firmware. `POST /set-clock` sends 2 frames (FC06 to HR 493 = Month+Day, HR 494 = Hour+Minute) and **skips Year**. To set Year, use `POST /s7-set-clock` (full RTC via S7 UserData). Comments in `proxy.js` near line ~785 document this — don't "fix" it by re-adding the HR 492 write.

There are two destructive test endpoints (`/test-fc16-rtc-DESTRUCTIVE`, `/test-vb-write`) with manual rate limits (60s and 5min cooldowns). These are diagnostic tools; do not call them in normal flows.

### Address aliases worth knowing

- `I1..I24`, `AI1..AI8` are **read-only** (physical inputs).
- `NI1..NI64`, `NQ1..NQ64`, `NAI1..NAI32`, `NAQ1..NAQ16` are **Network I/O** — virtual areas Siemens designed for HMI write-back into the LOGO! program. Use these from the browser instead of trying to write to `I*`.
- `NI` in Soft Comfort can be in either "Local" mode (coil 8320+) or "VM mapping" mode (a V-bit like `V0.0`). If `NI1` writes don't stick, the block is in VM mode — write to the configured V-bit instead.

## Conventions and constraints

- **Node version**: all three Node services require **Node 20+** (`engines.node` is pinned). `better-sqlite3` in the server needs build tools — the Dockerfile installs `python3 make g++` on Alpine; if running outside Docker, ensure these are available.
- **Single-process server**: Aedes broker, REST, WS, and SQLite all live in one Node process. There is no service split. Scaling notes are in `docs/architecture.md` (move to EMQX / Postgres past ~500 stations).
- **History GC**: runs every 6h, deletes by both age (`HISTORY_RETENTION_DAYS`, default 30) and per-station cap (`HISTORY_MAX_PER_STATION`, default 10000). The cap is enforced with a correlated subquery — fine at current scale, would need rewriting for high-throughput stations.
- **No tests**: changes are verified manually. If editing connection-management code in `proxy.js` or `gateway.js`, mention that it cannot be unit-tested without hardware and let the user know.
- **CORS**: `local-proxy` allows any origin (so `file://` and `localhost` UIs both work). The central server does not set CORS headers — the multi-station UI is served from the same origin.
- **TLS**: the server runs MQTT plain on 1883 and TLS on 8883 only if `TLS_CERT_PATH`/`TLS_KEY_PATH` are set. Production guidance in `docker-compose.yml` is to put Caddy in front and let it handle HTTPS + cert renewal.

## Where things live

- Architecture, MQTT schema, DB schema, failure modes, scale-out plan: `docs/architecture.md`
- Local proxy operator docs (Windows auto-start, troubleshoot, full address table with NI/V-bit details): `local-proxy/README.md`
- Top-level deployment scenarios, hardware requirements, BOM: `README.md`
- Technical proposal document (in Vietnamese, formal): `docs/de-xuat-ky-thuat.md`
