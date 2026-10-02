/* ============================================================
 * worker/src/ai-proxy.js —— AI 中转（/api/ai-proxy，features.md §8.2 / §9）
 * ------------------------------------------------------------
 * 本文件只提供纯函数件与出站执行器，不出现 Request 对象：请求解析与
 * 组装在 worker/src/index.js 的 /api/ai-proxy 路由完成（母本同款架构，
 * situation_puzzle worker/src/ai-proxy.js 照抄形状）。
 *
 *   aiProxyLimited(ip, now)      同 IP 日调用上限 5000 次（isolate 内存
 *                                Map，重启清零——已知限制，README 引用）
 *   buildProxyRequest(envelope,  信封 { url, body } + 入站头 → 出站件：
 *     incomingHeaders)             转发头白名单 / body ≤64KB / url-guard
 *   proxyFetch(upstream, ...)    出站执行器：只接收**已过 url-guard 校验**
 *                                的公网 URL（features.md §10 硬性验收，
 *                                30s 超时、响应 ≤1MB）
 * Key 只按请求透传（白名单头之一），不落盘、不打日志。
 * 错误码：URL_REJECTED / BODY_TOO_LARGE / RATE_LIMITED / UPSTREAM_ERROR。
 * ============================================================ */

import { safeOutboundUrl } from './url-guard.js';

const HEADER_WHITELIST = ['content-type', 'authorization', 'x-api-key', 'anthropic-version', 'accept'];
const BODY_MAX_BYTES = 64 * 1024; // 请求体上限（features.md §8.2）
const RESP_MAX_CHARS = 1024 * 1024; // 响应上限 1MB（ponytail: 按 text.length 近似）
export const UPSTREAM_TIMEOUT_MS = 30_000; // 单次转发超时（features.md §8.4）

/* 同 IP 日计数（isolate 内存；重启清零 = 已知限制） */
const ipDayCounts = new Map();

function dayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** 计数并判断：返回 true = 本 IP 今日已超 5000 次，拒绝。 */
export function aiProxyLimited(ip, now) {
  const day = dayKey(now);
  let rec = ipDayCounts.get(ip);
  if (!rec || rec.day !== day) {
    rec = { day, count: 0 };
    ipDayCounts.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > 5000;
}

/** 仅测试用：清空同 IP 日计数。 */
export function resetRateLimiterForTests() {
  ipDayCounts.clear();
}

/**
 * 信封 → 出站请求件。纯函数。
 * envelope: { url: string, body: object }（docs/ai-prompts.md §5.2 信封）；
 * incomingHeaders: 入站 Headers（只取白名单头透传，其余一律丢弃）。
 * 返回 { error: { code, status, message } } 或 { ok: true, url, headers, payload }。
 * 出站 url 一律取 safeOutboundUrl() 的返回值（校验与 fetch 强绑定）。
 */
export function buildProxyRequest(envelope, incomingHeaders) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.url !== 'string' ||
    !envelope.body ||
    typeof envelope.body !== 'object'
  ) {
    return { error: { code: 'BAD_REQUEST', status: 400, message: '信封必须是 { url: string, body: object }' } };
  }
  /* 硬性验收：出站目标必须经 url-guard 净化（features.md §10，永不简化） */
  const verdict = safeOutboundUrl(envelope.url);
  if (!verdict.ok) return { error: { code: 'URL_REJECTED', status: 400, message: verdict.reason } };

  const payload = JSON.stringify(envelope.body);
  if (new TextEncoder().encode(payload).length > BODY_MAX_BYTES) {
    return { error: { code: 'BODY_TOO_LARGE', status: 413, message: '请求体超过 64KB 上限' } };
  }

  const headers = {};
  for (const name of HEADER_WHITELIST) {
    const v = incomingHeaders && typeof incomingHeaders.get === 'function' ? incomingHeaders.get(name) : null;
    if (v != null) headers[name] = v;
  }
  if (headers['content-type'] == null) headers['content-type'] = 'application/json';
  return { ok: true, url: verdict.url, headers, payload };
}

/** 转发头白名单（测试与文档引用）。 */
export function forwardedHeaderNames() {
  return HEADER_WHITELIST.slice();
}

/**
 * 出站执行器（母本同款形状）：upstream 必须是 buildProxyRequest 校验通过
 * 的 URL，本函数不再触碰任何请求数据。30s 超时，响应 ≤ 1MB。
 * fetchImpl 供测试注入；生产用全局 fetch。
 * 返回 { status, text, contentType } 或 { error: 'UPSTREAM_ERROR', message }。
 */
export async function proxyFetch(upstream, headers, payload, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);
  try {
    const res = await doFetch(upstream, { method: 'POST', headers, body: payload, signal: ctrl.signal });
    /* 下行截断 ≤1MB：上游异常吐超长正文也不至于撑爆 Worker（母本同款） */
    const text = (await res.text()).slice(0, RESP_MAX_CHARS);
    return { status: res.status, text, contentType: res.headers.get('content-type') };
  } catch (e) {
    return { error: 'UPSTREAM_ERROR', message: '转发失败或超时（30s）' };
  } finally {
    clearTimeout(timer);
  }
}
