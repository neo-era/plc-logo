'use strict';
/**
 * Gửi tin qua Zalo Bot Platform chính thức: POST {base}/bot{TOKEN}/sendMessage {chat_id, text} (tối đa 2000 ký tự).
 * Không dùng đăng nhập Zalo web bằng cookie.
 */
const DEFAULT_BASE = 'https://bot-api.zaloplatforms.com';

function createZalo({ token, base = DEFAULT_BASE, fetchFn = globalThis.fetch, timeoutMs = 10000 }) {
  async function call(method, body) {
    if (!token) return { ok: false, error: 'NO_TOKEN' };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchFn(`${base}/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
      });
      const j = await r.json().catch(() => ({}));
      return j && j.ok ? { ok: true, result: j.result } : { ok: false, error: j.description || `HTTP_${r.status}` };
    } catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : e.message }; }
    finally { clearTimeout(t); }
  }
  return {
    sendMessage: (chatId, text) => call('sendMessage', { chat_id: String(chatId), text: String(text).slice(0, 2000) }),
    getMe: () => call('getMe', {}),
  };
}

// Kênh dự phòng Telegram (bot cảnh báo hệ thống có sẵn của LAVIPCO Server): cùng giao thức Bot API.
function createTelegram({ token, chatId, fetchFn = globalThis.fetch }) {
  const c = createZalo({ token, base: 'https://api.telegram.org', fetchFn });
  return { enabled: !!(token && chatId), send: text => c.sendMessage(chatId, '[DỰ PHÒNG — Zalo lỗi]\n' + text) };
}

module.exports = { createZalo, createTelegram, DEFAULT_BASE };
