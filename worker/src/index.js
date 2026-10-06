/* ============================================================
 * worker/src/index.js —— Worker 入口（路由 + 限流 + CORS + ai-proxy 路由）
 * ------------------------------------------------------------
 * 路由表（features.md §9）：
 *   POST /api/room/new          建房返回 6 位房号（同 IP 每日 100 房）
 *   POST /api/room/:code/:act   房内动作转发 DO（join / ready / start / speak /
 *                               vote / wolf-chat / wolf-target / guard-protect /
 *                               seer-check / witch-move / hunter-shoot /
 *                               elect-run / elect-speak / elect-withdraw /
 *                               elect-vote / badge-move / heartbeat /
 *                               ai_view[owner 专属] /
 *                               drive_ai[owner 专属，服务端发起 AI 行动]）
 *   GET  /api/room/:code/state  轮询快照（uid + rev 查询参数；无变化回 unchanged）
 *   POST /api/ai-proxy          AI 中转（请求侧在此，出站执行在 ai-proxy.js，
 *                               出站目标必过 url-guard——母本同款架构）
 *   POST /api/ai-roster         AI 名册抽取：{ count } → [{ nick, persona }]
 *                               （人格洗牌不重复 + 人格池网名，与身份无关，ADR-0009；
 *                               联机开局由 DO 内部用同一份函数抽取，不经此接口）
 *   GET  /api/health            健康检查
 * CORS 只放行 ALLOWED_ORIGINS（[vars]）；房号字符集去易混 I/O/0/1（§7.1）。
 * DO 转发与命名空间绑定一律经 do-rpc.js（stub.fetch 官方 API，不出网络
 * 边界）；建房限流在 rate-limit.js；AI 出站在 ai-proxy.js。
 * DO 类从本入口导出（wrangler main）。
 * ============================================================ */

import { aiProxyLimited, buildProxyRequest, proxyFetch, UPSTREAM_TIMEOUT_MS, isDefaultAiUrl } from './ai-proxy.js';
import { doRpc, roomStub } from './do-rpc.js';
import { newRoomLimited } from './rate-limit.js';
import { drawRoster } from '../../shared/roster.js';

export { Room } from './room.js';
export { resetRoomLimiterForTests } from './rate-limit.js';

/* 6 位房号字符集：去易混 I / O / 0 / 1（features.md §7.1）。
   随机源用 crypto.getRandomValues（母本同款，非 Math.random）。 */
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* [0,1) 浮点随机源（shared/roster.js drawRoster 注入用，与房号同款 crypto） */
const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const ROOM_ACT =
  'join|ready|start|speak|vote|wolf-chat|wolf-target|guard-protect|seer-check|witch-move|hunter-shoot|elect-run|elect-speak|elect-withdraw|elect-vote|badge-move|heartbeat|ai_view|drive_ai';

/* CORS：只回放 ALLOWED_ORIGINS 命中的 Origin；无 Origin（同源 / curl）取白名单首项 */
function corsHeaders(env, origin) {
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let allow = '';
  if (!list.length) allow = origin || '*';
  else if (origin && list.includes(origin)) allow = origin;
  else if (!origin) allow = list[0];
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'cache-control': 'no-store',
  };
  if (allow) headers['access-control-allow-origin'] = allow;
  return headers;
}

function json(data, env, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsHeaders(env, origin)),
  });
}

/* 把 DO 的响应补上 CORS 头再回给浏览器 */
function withCors(res, env, origin) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, origin))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('origin') || '';
    const reply = (data, status) => json(data, env, status, origin);
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    if (path === '/api/health') {
      return reply({ ok: true, service: 'werewolf-room', at: Date.now() });
    }

    /* ---- AI 名册抽取（ADR-0009）：人格洗牌不重复 + 人格池网名，与身份无关。
       纯计算零上游，不设限流；count 越界 / 缺失 → 400。 ---- */
    if (path === '/api/ai-roster' && request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch (e) {
        body = {};
      }
      try {
        return reply({ ok: true, roster: drawRoster(body && body.count, cryptoRand) });
      } catch (e) {
        return reply({ error: 'BAD_REQUEST', message: String((e && e.message) || e) }, 400);
      }
    }

    /* ---- 建房：限流 → 生成房号 → DO init ---- */
    if (path === '/api/room/new' && request.method === 'POST') {
      if (newRoomLimited(ip, Date.now())) {
        return reply({ error: 'RATE_LIMITED', message: '今日建房数量已达上限（100）' }, 429);
      }
      const buf = new Uint8Array(6);
      crypto.getRandomValues(buf);
      let code = '';
      for (let i = 0; i < 6; i++) code += ROOM_CHARS[buf[i] % ROOM_CHARS.length];
      const raw = await request.text();
      const init = await doRpc(roomStub(env, code), `https://do/?action=new&code=${code}`, {
        method: 'POST',
        body: raw,
      });
      return withCors(init, env, origin);
    }

    /* ---- 房内路由：GET state 轮询 / POST 动作 ---- */
    const m = path.match(/^\/api\/room\/([A-HJ-NP-Z2-9]{6})(?:\/([a-z_-]+))?$/);
    if (m) {
      const code = m[1];
      if (m[2] === 'state') {
        if (request.method !== 'GET') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
        /* 显式重组查询串（uid / rev 透传给 DO），不用字符串拼接 search */
        const q = new URL('https://do/?action=state');
        for (const key of ['uid', 'rev']) {
          const v = url.searchParams.get(key);
          if (v != null) q.searchParams.set(key, v);
        }
        const snap = await doRpc(roomStub(env, code), q.toString());
        return withCors(snap, env, origin);
      }
      if (m[2] && new RegExp(`^(?:${ROOM_ACT})$`).test(m[2])) {
        if (request.method !== 'POST') return reply({ error: 'METHOD_NOT_ALLOWED' }, 405);
        const raw = await request.text();
        const out = await doRpc(roomStub(env, code), `https://do/?action=${encodeURIComponent(m[2])}`, {
          method: 'POST',
          body: raw,
        });
        return withCors(out, env, origin);
      }
      return reply({ error: 'NOT_FOUND' }, 404);
    }

    /* ---- AI 中转：请求侧在此，出站执行在 ai-proxy.js（母本同款架构） ---- */
    if (path === '/api/ai-proxy' && request.method === 'POST') {
      if (aiProxyLimited(ip, Date.now())) {
        return reply({ error: 'RATE_LIMITED', message: '同 IP 今日 AI 调用已达上限（5000）' }, 429);
      }
      let envelope = null;
      try {
        envelope = await request.json();
      } catch (e) {
        envelope = null;
      }
      const built = buildProxyRequest(envelope, request.headers);
      if (built.error) {
        return reply({ error: built.error.code, message: built.error.message }, built.error.status);
      }
      /* 体验通道：请求未带 key 且目标就是体验通道上游 → 注入 Secret（features.md §8.2）。
         key 只发往默认 baseUrl，绝不被带去其他主机；滥用面由 aiProxyLimited 兜住。 */
      if (!built.headers.authorization && env.DEFAULT_AI_KEY && isDefaultAiUrl(built.url)) {
        built.headers.authorization = `Bearer ${env.DEFAULT_AI_KEY}`;
      }
      const out = await proxyFetch(built.url, built.headers, built.payload, UPSTREAM_TIMEOUT_MS);
      if (out.error) return reply({ error: out.error, message: out.message }, 502);
      return new Response(out.text, {
        status: out.status,
        headers: Object.assign(
          { 'content-type': out.contentType || 'application/json', 'cache-control': 'no-store' },
          corsHeaders(env, origin)
        ),
      });
    }

    return reply({ error: 'NOT_FOUND' }, 404);
  },
};
