/* ============================================================
 * js/archive.js —— 本地存档 / 回放 / 战绩（§3，ADR-0015）
 * ------------------------------------------------------------
 * 结构：纯函数（node --test 可直接 import，顶层不碰 DOM / storage）+
 * localStorage 薄 I/O（key 'ww_archive'，try/catch 静默——存不下就丢，
 * 同 ww_solo 口径；Quota 时减半重试一次）。
 * 记录（v1）：
 *   { v: 1, id, ts, mode: 'solo'|'online', board: { id, name },
 *     winner, reason, day, players: [{ seat, nick, isAI, role, death?, won }],
 *     log: [t-schema 全量公开事件] }
 *   won 按 isWolf 判定（§1.2，ADR-0013：狼王计入狼侧）；
 *   id：solo = `solo:${seed}`（hStart 已存 s.seed）、online = `online:${room.code}`，
 *   由调用方经 meta 传入——mergeArchive 按 id 去重天然幂等（刷新恢复 /
 *   重复进入 revealed 屏不重复入档，§3.2）。
 * 战绩只统计真人（isAI 座位不进 aggregateStats，§3.3）；
 * 「我」的高亮由前端按当前昵称弱匹配（文档注明，本模块不做）。
 * ============================================================ */

import { BOARDS, DEFAULT_BOARD, isWolf } from "../shared/game.js";

export const ARCHIVE_MAX = 30; // §3.1 存档上限（超出丢最旧）
const KEY = "ww_archive";

const hasStorage = () => typeof localStorage !== "undefined";

/* ---------- 纯函数 ---------- */

/**
 * 内核终局 state + t-schema 公开事件 log → 存档记录（§3.1）。
 * meta：{ mode: 'solo'|'online'（缺省 solo）、id（记录去重键，缺省按 seed 推导）、
 * ts（落档时间戳，缺省 Date.now）}。调用点 = 进入 revealed 的那一次（§3.2）。
 * won 判定按 isWolf（狼王 = 狼侧，ADR-0013）；winner 缺失（未终局误调）时 won=null。
 */
export function buildArchiveRecord(state, log, meta = {}) {
  if (!state || typeof state !== "object") return null;
  const boardId = state.board || DEFAULT_BOARD;
  const board = Object.prototype.hasOwnProperty.call(BOARDS, boardId) ? BOARDS[boardId] : BOARDS[DEFAULT_BOARD];
  const winner = state.winner;
  const mode = meta.mode === "online" ? "online" : "solo";
  return {
    v: 1,
    id: typeof meta.id === "string" && meta.id ? meta.id : `solo:${state.seed}`,
    ts: typeof meta.ts === "number" ? meta.ts : Date.now(),
    mode,
    board: { id: boardId, name: board.name },
    winner: winner == null ? null : winner,
    reason: state.reason == null ? null : state.reason,
    day: state.day,
    players: (state.players || [])
      .filter(Boolean)
      .map((p) => ({
        seat: p.seat,
        nick: p.nick,
        isAI: !!p.isAI,
        role: p.role,
        ...(p.death ? { death: p.death } : {}),
        won: winner === "wolf" ? isWolf(p.role) : winner === "good" ? !isWolf(p.role) : null,
      })),
    log: Array.isArray(log) ? log.slice() : [],
  };
}

/**
 * 按记录 id 去重并入栈（unshift），超上限丢最旧（§3.1）。纯函数：不改入参，
 * 返回新数组。同 id 重复保存幂等（重复进入 revealed 屏不重复入档）。
 */
export function mergeArchive(list, rec) {
  /* 坏记录 / 缺 id：原样返回列表副本（静默容错，不阻断终局复盘） */
  if (!rec || typeof rec !== "object" || !rec.id) return Array.isArray(list) ? list.slice() : [];
  const base = Array.isArray(list) ? list.filter((x) => x && x.id !== rec.id) : [];
  return [rec, ...base].slice(0, ARCHIVE_MAX);
}

/**
 * 按昵称聚合战绩（§3.3）：局数 / 胜场 / 胜率 / 角色分布；isAI 座位不进战绩。
 * 返回按局数降序的 [{ nick, games, wins, rate, roles }]；roles = { 角色名: 局数 }。
 * 弱口径：同昵称即同一人（文档注明）；won=null（未终局）不计胜负但仍计局数。
 */
export function aggregateStats(list) {
  const byNick = new Map();
  for (const rec of Array.isArray(list) ? list : []) {
    if (!rec || !Array.isArray(rec.players)) continue;
    for (const p of rec.players) {
      if (!p || p.isAI) continue; // 战绩只统计真人
      let e = byNick.get(p.nick);
      if (!e) {
        e = { nick: p.nick, games: 0, wins: 0, roles: {} };
        byNick.set(p.nick, e);
      }
      e.games += 1;
      if (p.won === true) e.wins += 1;
      if (p.role) e.roles[p.role] = (e.roles[p.role] || 0) + 1;
    }
  }
  return [...byNick.values()]
    .map((e) => ({ ...e, rate: e.games ? Math.round((e.wins / e.games) * 100) / 100 : 0 }))
    .sort((a, b) => b.games - a.games || (a.nick < b.nick ? -1 : 1));
}

/* ---------- localStorage 薄 I/O（静默容错，同 ww_solo 口径） ---------- */

/** 读档：坏 JSON / 无 storage 一律回 []，不抛错。 */
export function loadArchives() {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 存档一条记录：mergeArchive 后整写。写满 Quota 时减半（丢最旧一半）重试，
 * 仍失败则静默丢弃（§3.1）。返回最终写盘成功的数组（全败回 []）。
 */
export function saveArchive(rec) {
  if (!hasStorage() || !rec || typeof rec !== "object") return [];
  const merged = mergeArchive(loadArchives(), rec);
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  } catch (e) {
    try {
      const half = merged.slice(0, Math.max(1, Math.ceil(merged.length / 2)));
      localStorage.setItem(KEY, JSON.stringify(half));
      return half;
    } catch (e2) {
      return []; // 静默：存不下就丢，不阻断终局复盘
    }
  }
}
