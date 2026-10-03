/* ============================================================
 * js/ai.js —— BYO 配置、AI 请求（/api/ai-proxy）与客户端侧 AI 数据件
 * ------------------------------------------------------------
 * 职责（docs/ai-prompts.md §5 数据契约的浏览器侧实现）：
 *   - BYO 配置读写：baseUrl / apiKey / model 只存 localStorage，按请求透传，
 *     服务端不落盘（features.md §8.2）
 *   - requestChat(messages)：唯一请求格式（§5.0）经 Worker /api/ai-proxy 转发
 *     （浏览器不直连上游，解 CORS）；30s 超时、失败重试 1 次（§8.4）
 *   - parseReply(phase, text)：§5.1 宽容解析，归属本文件（§6 已知边界 3）
 *   - toHistory / windowHistory / roleCardOf / phaseOf：单机模式组装
 *     buildMessages(history, roleCard, phase) 的三个输入（§5.2 时序 2–4）
 * 与 worker/src/room-logic.js 的关系：windowHistory / parseReply / roleCardOf /
 *   phaseOf 在那边各有一份服务端同款（drive_ai 路径用）。两边刻意各自持有——
 *   worker/ 是后端部署边界，前端不自 Pages 引用 worker/src；docs 把解析与窗口
 *   规则点名归 js/ai.js。改任一边的规则时同步另一边（漂移风险已知晓）。
 * 本模块不碰 DOM（设置屏接线在 js/app.js），node --test 可直接 import。
 * ============================================================ */

import * as game from "../shared/game.js";
import { buildMessages } from "./prompts.js";
import { apiBase } from "./net.js";

const REQ_TIMEOUT_MS = 30_000; // §8.4 单次请求超时
const RETRY = 2; // 共尝试 2 次（失败重试 1 次）

/* ---------- BYO 配置（localStorage，key 前缀 ww_ai_） ---------- */

export function loadConfig() {
  const g = (k) => (typeof localStorage !== "undefined" ? localStorage.getItem(k) : null) || "";
  return {
    baseUrl: g("ww_ai_base").replace(/\/+$/, ""),
    key: g("ww_ai_key"),
    model: g("ww_ai_model"),
  };
}

export function saveConfig({ baseUrl, key, model }) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem("ww_ai_base", String(baseUrl || "").trim().replace(/\/+$/, ""));
  localStorage.setItem("ww_ai_key", String(key || "").trim());
  localStorage.setItem("ww_ai_model", String(model || "").trim());
}

export function hasConfig() {
  const c = loadConfig();
  return !!(c.baseUrl && c.model); // key 可空（本地网关类上游不要 Key）
}

/* ---------- AI 请求（§5.0 唯一格式 + §5.2 信封） ---------- */

/**
 * messages = buildMessages(...) 的返回值，原样放入请求体。
 * 返回正文字符串；失败（超时 / 非 200 / 无 choices / 两次尝试皆败）返回 null，
 * 调用方按 §8.4 走确定性回退（shared/game.js applyFallback）。
 */
export async function requestChat(messages) {
  const cfg = loadConfig();
  if (!cfg.baseUrl || !cfg.model) return null;
  const envelope = {
    url: cfg.baseUrl + "/chat/completions", // §5.2：前端拼完整地址
    body: { model: cfg.model, messages, temperature: 0.7, max_tokens: 800 }, // 冻结值（§5.0）
  };
  for (let attempt = 0; attempt < RETRY; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
      let res;
      try {
        const headers = { "content-type": "application/json" };
        if (cfg.key) headers.authorization = `Bearer ${cfg.key}`; // 按请求透传（§8.2 头白名单）
        res = await fetch(apiBase() + "/api/ai-proxy", {
          method: "POST",
          headers,
          body: JSON.stringify(envelope),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) continue; // 限流 / URL_REJECTED / UPSTREAM_ERROR 一律按失败重试
      const j = await res.json();
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof content === "string" && content.trim()) return content;
    } catch (e) {
      /* 超时 / 断网 → 下一次尝试 */
    }
  }
  return null;
}

/* ---------- §5.1 响应解析（宽容序：save/skip → 第一个 1–9 数字） ----------
 * 返回 shared/game.js 内核动作（不带 seat，调用方补）；解析失败返回 null → 回退。
 * 狼阶段是两行格式（密聊 + 投票），不走此函数，见 parseWolfReply。 */
export function parseReply(phase, text) {
  if (typeof text !== "string") return null;
  if (phase === "speak" || phase === "lastwords" || phase === "pk_speak") {
    const t = text.trim().slice(0, 200); // 硬上限 200 字（§5.8），DO / 内核也会拒超长
    return t ? { type: "speak", text: t } : null;
  }
  const s = text.trim().toLowerCase().replace(/[\s.,;:!?，。；：！？、"'`()[\]{}<>《》-]/g, "");
  if (s === "save") return phase === "witch" ? { type: "witch_move", move: "save" } : null;
  if (s === "skip" || s === "pass") {
    if (phase === "witch") return { type: "witch_move", move: "skip" };
    if (phase === "hunter") return { type: "hunter_shoot", target: null };
    if (phase === "vote" || phase === "pk_vote") return { type: "vote", target: null };
    return null; // wolf / seer 不可 skip（§5.10 / §4.1.2）→ 回退
  }
  const m = s.match(/[1-9]/);
  if (!m) return null;
  const n = Number(m[0]);
  switch (phase) {
    case "seer":
      return { type: "seer_check", target: n };
    case "witch":
      return { type: "witch_move", move: "poison", target: n };
    case "hunter":
      return { type: "hunter_shoot", target: n };
    case "vote":
    case "pk_vote":
      return { type: "vote", target: n };
    default:
      return null;
  }
}

/**
 * §4.1.1 狼阶段两行回复解析（与 worker/src/room-logic.js parseWolfReply 同口径）：
 * 第一行 = 密聊发言（「过」/空 → null），第二行（或剩余文本）第一个 1–9 数字 = 投票。
 * target 为 null 时调用方走确定性回退随机投票，密聊内容保留。
 */
export function parseWolfReply(text) {
  const out = { chat: null, target: null };
  if (typeof text !== "string") return out;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return out;
  const strip = (l) => l.replace(/[\s.,;:!?，。；：！？、"'`()[\]{}<>《》-]/g, "");
  if (lines.length === 1) {
    const one = strip(lines[0]);
    if (/^[1-9]$/.test(one)) out.target = Number(one);
    else out.chat = cleanChat(lines[0]);
    return out;
  }
  out.chat = cleanChat(lines[0]);
  const m = lines.slice(1).join(" ").match(/[1-9]/);
  out.target = m ? Number(m[0]) : null;
  return out;
}

function cleanChat(line) {
  const t = line.replace(/^["'「『]+|["'」』]+$/g, "").trim();
  if (!t || ["过", "pass", "skip", "无", "没事"].includes(t.toLowerCase())) return null;
  return t.slice(0, 60); // 与内核 WOLF_CHAT_MAX 同口径截断
}

/* ---------- 内核公开事件 → §1.3 history（单机本地账本用） ---------- */

export function toHistory(events) {
  const out = [];
  for (const ev of events || []) {
    switch (ev.type) {
      case "day_announce":
        out.push({ t: "deaths", day: ev.day, seats: ev.dead });
        break;
      case "last_words":
        out.push({ t: "lastwords", day: ev.day, seat: ev.seat, text: ev.text });
        break;
      case "speech":
        out.push({ t: "speech", day: ev.day, seat: ev.seat, text: ev.text });
        break;
      case "pk_speech":
        out.push({ t: "pk_speak", day: ev.day, seat: ev.seat, text: ev.text });
        break;
      case "vote":
        out.push({ t: "vote", day: ev.day, voter: ev.seat, target: ev.target });
        break;
      case "vote_result":
        if (ev.pk) out.push({ t: "tie", day: ev.day, seats: ev.pk });
        out.push({ t: "exile", day: ev.day, seat: ev.exiled == null ? null : ev.exiled });
        break;
      case "hunter_shoot":
        out.push({ t: "hunter", day: ev.day, seat: ev.seat, target: ev.target });
        break;
      case "hunter_skip":
        out.push({ t: "hunter", day: ev.day, seat: ev.seat, target: null });
        break;
      default:
        break; // game_start / game_over / hunter_flip：不进 AI 历史（§1.3 schema 外）
    }
  }
  return out;
}

/* ---------- §5.4 历史窗口：最近 2 个完整白天全量，更早天数压 digest ---------- */

function digestOfDay(day, evs) {
  const dead = new Set();
  const parts = [];
  for (const ev of evs) {
    if (ev.t === "deaths") {
      ev.seats.forEach((s) => dead.add(s));
      parts.push(ev.seats.length ? `昨晚 ${ev.seats.join("、")} 号死亡` : "平安夜");
    } else if (ev.t === "exile") {
      if (ev.seat != null) {
        dead.add(ev.seat);
        parts.push(`${ev.seat} 号被放逐`);
      } else parts.push("无人出局");
    } else if (ev.t === "hunter" && ev.target != null) {
      dead.add(ev.target);
      parts.push(`猎人 ${ev.seat} 号带走 ${ev.target} 号`);
    }
  }
  // dead 必须完整列出该天全部出局座位，否则 buildMessages 的存活推导出错（§5.4）
  return { t: "digest", day, dead: [...dead].sort((a, b) => a - b), text: parts.join("，") || "平安日" };
}

export function windowHistory(log, maxChars = 60_000) {
  const byDay = new Map();
  let maxDay = 0;
  for (const ev of log) {
    if (!Number.isInteger(ev.day) || ev.day < 1) continue;
    maxDay = Math.max(maxDay, ev.day);
    if (!byDay.has(ev.day)) byDay.set(ev.day, []);
    byDay.get(ev.day).push(ev);
  }
  const out = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const evs = byDay.get(day);
    if (day >= maxDay - 2) out.push(...evs); // 当前天 + 最近 2 个完整白天
    else out.push(digestOfDay(day, evs));
  }
  let json = JSON.stringify(out);
  while (json.length > maxChars && out.length > 1) {
    out.shift(); // 再超限从最旧开始丢弃（§5.4）
    json = JSON.stringify(out);
  }
  return out;
}

/* ---------- 单机：子阶段 → AI 任务阶段（shared/prompts.js PHASES） ---------- */

export function phaseOf(g) {
  switch (`${g.phase}:${g.subPhase}`) {
    case "night:wolf":
      return "wolf";
    case "night:seer":
      return "seer";
    case "night:witch":
      return "witch";
    case "day:night_hunter":
    case "day:hunter":
      return "hunter";
    case "day:lastwords":
    case "day:exile_lastwords":
      return "lastwords";
    case "day:speak":
      return "speak";
    case "day:pk_speak":
      return "pk_speak";
    case "day:vote":
      return "vote";
    case "day:pk_vote":
      return "pk_vote";
    default:
      return null;
  }
}

/* 内核角色名 → AI 契约角色名（docs/ai-prompts.md §1.2） */
const PROMPT_ROLE = { werewolf: "wolf", villager: "villager", seer: "seer", witch: "witch", hunter: "hunter" };

/** 单机本地组装该座位的身份卡（§1.2 schema；本地持有全量状态，只取合法私有字段）。 */
export function roleCardOf(g, seat) {
  const p = g.players[seat - 1];
  if (!p) return null;
  const card = { seat, role: PROMPT_ROLE[p.role] || p.role };
  if (p.role === "werewolf") {
    card.wolves = g.players.filter((x) => x && x.role === "werewolf").map((x) => x.seat);
    if (g.phase === "night" && g.subPhase === "wolf" && g.night) {
      card.wolfChat = g.night.wolfChat || []; // §4.1.1 狼自己的私有频道进 roleCard（上下文铁律不破）
      card.wolfVotes = g.night.wolfVotes || {};
      card.captain = game.wolfCaptain(g);
    }
  }
  if (p.role === "seer") {
    card.checks = (g.seerChecks || []).map((c) => ({ night: c.night, seat: c.target, result: c.isWolf ? "wolf" : "good" }));
  }
  if (p.role === "witch" && g.witch) {
    card.antidote = g.witch.antidote > 0;
    card.poison = g.witch.poison > 0;
    const blade = game.witchSeesBlade(g); // 仅女巫行动夜且解药未用（§4.1.3）
    if (blade != null) card.knifeTarget = blade;
  }
  return card;
}

/**
 * 单机：为 AI 座位跑一次「取卡 → 组消息 → 请求 → 解析」。
 * 返回 { chat, action }：chat 为狼队密聊内容（wolf 阶段可能非 null，调用方先提交）；
 * action 为内核动作（含 seat），null = 请求失败 / 无有效投票，调用方走回退。
 * buildMessages 抛错（白名单 / 角色强一致校验）按请求失败处理（§1.4 / §8.4）。
 */
export async function decideFor(g, log, seat) {
  const phase = phaseOf(g);
  if (!phase) return { chat: null, action: null };
  try {
    const card = roleCardOf(g, seat);
    const messages = buildMessages(windowHistory(log), card, phase);
    const text = await requestChat(messages);
    if (phase === "wolf") {
      const w = text != null ? parseWolfReply(text) : { chat: null, target: null };
      return {
        chat: w.chat,
        action: w.target != null ? { type: "wolf_target", target: w.target, seat } : null,
      };
    }
    const parsed = text != null ? parseReply(phase, text) : null;
    return { chat: null, action: parsed ? { ...parsed, seat } : null };
  } catch (e) {
    return { chat: null, action: null };
  }
}

/* ---------- AI 设置：测试连接（短提示词探活，不走游戏流程） ---------- */

/**
 * 用当前配置发一条最小请求探活（与游戏同走 /api/ai-proxy，测的是完整链路）。
 * 单次尝试不重试（快速反馈）。返回 { ok, ms?, reply?, error? }，error 为可读原因。
 */
export async function testConnection(cfg = loadConfig()) {
  if (!cfg.baseUrl || !cfg.model) return { ok: false, error: "先填接口地址与模型名" };
  if (!/^https?:\/\//i.test(cfg.baseUrl)) return { ok: false, error: "接口地址必须以 http:// 或 https:// 开头" };
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const headers = { "content-type": "application/json" };
    if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
    const res = await fetch(apiBase() + "/api/ai-proxy", {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions",
        body: {
          model: cfg.model,
          messages: [{ role: "user", content: "连接测试：请只回复两个字——正常" }],
          temperature: 0,
          max_tokens: 16,
        },
      }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = j && (j.message || j.error);
      return { ok: false, error: `HTTP ${res.status}${reason ? "：" + reason : ""}` };
    }
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof content !== "string" || !content.trim()) return { ok: false, error: "上游返回了空回复" };
    return { ok: true, ms: Date.now() - started, reply: content.trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "超时（15 秒无响应）" : "网络请求失败（检查地址与网络）" };
  } finally {
    clearTimeout(timer);
  }
}
