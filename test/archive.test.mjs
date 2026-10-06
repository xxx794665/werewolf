/* ============================================================
 * test/archive.test.mjs —— 本地存档 / 回放 / 战绩纯函数与 I/O（§3 / §5.3，ADR-0015）
 * ------------------------------------------------------------
 * 覆盖：
 *   1. buildArchiveRecord：记录形状（v1 全字段）、won 判定（isWolf 口径，
 *      狼王 = 狼侧）、wolfking 板真实终局、未终局 won=null；
 *   2. mergeArchive：按 id 去重幂等、unshift 在最前、上限 30 丢最旧、不改入参；
 *   3. aggregateStats：按昵称聚合局数 / 胜场 / 胜率 / 角色分布，排除 isAI 座位；
 *   4. loadArchives / saveArchive：localStorage key 'ww_archive'、坏 JSON 静默
 *      回 []、Quota 超限减半重试、无 storage 环境可用（顶层零 DOM 依赖）。
 * 全量 node --test 由工作流统一执行；本文件可单跑。
 * ============================================================ */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as game from "../shared/game.js";
import * as ai from "../js/ai.js";
import * as archive from "../js/archive.js";

/* ---------- 通用：固定种子真实终局（回退驱动收敛，同 frontend.test 单机整局口径） ---------- */

/** 开一局 solo（可指定板子），回退驱动到 revealed，返回 { state, log }。 */
function playToRevealed(board) {
  let s = game.advance(game.createInitialState(), { type: "join", nick: "玩家甲", uid: "u1" }).state;
  s = game.advance(s, { type: "ready", seat: 1, ready: true }).state;
  const r = game.advance(s, { type: "start", seed: 20261005, solo: true, board });
  assert.equal(r.error, null, `solo 开局不应失败：${r.error}`);
  s = r.state;
  const log = [];
  let guard = 0;
  while (s.phase !== "revealed" && guard++ < 500) {
    const seat = game.pendingSeat(s);
    assert.notEqual(seat, null, `对局中应有待行动座位（day=${s.day} ${s.subPhase}）`);
    const step = game.applyFallback(s, seat);
    assert.equal(step.error, null, `回退不应失败（seat=${seat}）：${step.error}`);
    s = step.state;
    log.push(...ai.toHistory(step.events));
  }
  assert.equal(s.phase, "revealed", "整局必须收敛");
  return { state: s, log };
}

/* ---------- 1. buildArchiveRecord（§3.1） ---------- */

test("buildArchiveRecord：标准板记录形状（v1 全字段、board 带名、log 全量、id 按 seed 推导）", () => {
  const { state, log } = playToRevealed();
  const rec = archive.buildArchiveRecord(state, log, { mode: "solo", ts: 123456 });
  assert.equal(rec.v, 1);
  assert.equal(rec.id, `solo:${state.seed}`, "缺省 id 按 seed 推导（§3.1）");
  assert.equal(rec.ts, 123456);
  assert.equal(rec.mode, "solo");
  assert.deepEqual(rec.board, { id: "standard", name: "标准板" });
  assert.equal(rec.winner, state.winner);
  assert.equal(rec.reason, state.reason);
  assert.equal(rec.day, state.day);
  assert.equal(rec.players.length, 9);
  for (const p of rec.players) {
    assert.ok(game.isWolf(p.role) || ["villager", "seer", "witch", "hunter"].includes(p.role), `角色合法：${p.role}`);
    assert.equal(typeof p.nick, "string");
    assert.equal(typeof p.isAI, "boolean");
    if (!p.death) assert.equal("death" in p, false, "存活座位不带 death 字段");
    else assert.ok(p.death.day >= 1 && ["blade", "poison", "shot", "exile"].includes(p.death.cause));
  }
  assert.deepEqual(rec.log, log, "log 为 t-schema 全量公开事件副本");
  assert.notEqual(rec.log, log, "log 是副本不是引用");
  // meta.id 优先于 seed 推导（联机用 room.code）
  const rec2 = archive.buildArchiveRecord(state, log, { mode: "online", id: "online:ABC234", ts: 1 });
  assert.equal(rec2.id, "online:ABC234");
  assert.equal(rec2.mode, "online");
});

test("buildArchiveRecord：won 判定按 isWolf（狼王 = 狼侧，§1.2 / ADR-0013）；狼王板真实终局", () => {
  const { state, log } = playToRevealed("wolfking");
  assert.equal(state.board, "wolfking");
  const rec = archive.buildArchiveRecord(state, log, { mode: "solo", ts: 1 });
  assert.deepEqual(rec.board, { id: "wolfking", name: "狼王板" });
  const expectWon = (role) => (state.winner === "wolf" ? game.isWolf(role) : !game.isWolf(role));
  assert.ok(state.players.some((p) => p.role === "wolfking"), "狼王板必含狼王");
  for (const p of rec.players) {
    assert.equal(p.won, expectWon(p.role), `座位 ${p.seat}（${p.role}）won 必须按 isWolf 口径`);
  }
});

test("buildArchiveRecord：未终局（winner 缺失）won=null、winner/reason 也为 null（容错不改写）", () => {
  let s = game.advance(game.createInitialState(), { type: "join", nick: "玩家甲", uid: "u1" }).state;
  s = game.advance(s, { type: "ready", seat: 1, ready: true }).state;
  s = game.advance(s, { type: "start", seed: 7, solo: true }).state;
  const rec = archive.buildArchiveRecord(s, [], { mode: "solo", ts: 1 });
  assert.equal(rec.winner, null);
  assert.equal(rec.reason, null);
  for (const p of rec.players) assert.equal(p.won, null, "未终局不判胜负");
  assert.equal(archive.buildArchiveRecord(null, [], {}), null, "坏状态回 null 不抛错");
});

/* ---------- 2. mergeArchive（§3.1） ---------- */

test("mergeArchive：按 id 去重幂等、unshift 在最前、上限 30 丢最旧、不改入参", () => {
  const mk = (id) => ({ v: 1, id, ts: Number(id.slice(1)), players: [], log: [] });
  // 去重幂等：重复保存同 id 不重复入档（刷新恢复 / 重复进入 revealed 屏）
  const once = archive.mergeArchive([mk("a1"), mk("a2")], mk("a1"));
  assert.deepEqual(once.map((r) => r.id), ["a1", "a2"], "同 id 重存幂等（旧条目被顶到最前）");
  const twice = archive.mergeArchive(once, mk("a1"));
  assert.deepEqual(twice.map((r) => r.id), ["a1", "a2"], "再存仍幂等");
  // unshift：新记录在最前
  const grown = archive.mergeArchive(twice, mk("a0"));
  assert.deepEqual(grown.map((r) => r.id), ["a0", "a1", "a2"]);
  // 上限 30：超限丢最旧。列表方向与真实档案一致（最新在前，b34 最新、b00 最旧）
  const big = [];
  for (let i = 34; i >= 0; i--) big.push(mk(`b${String(i).padStart(2, "0")}`));
  const capped = archive.mergeArchive(big, mk("b99"));
  assert.equal(capped.length, archive.ARCHIVE_MAX, "上限 30");
  assert.equal(capped[0].id, "b99", "最新在最前");
  assert.equal(capped[29].id, "b06", "截到 b06（35+1-30：丢最旧 6 条）");
  for (const id of ["b00", "b01", "b02", "b03", "b04", "b05"]) {
    assert.ok(!capped.some((r) => r.id === id), `最旧 ${id} 被丢`);
  }
  // 纯函数：不改入参
  const input = [mk("a1"), mk("a2")];
  archive.mergeArchive(input, mk("a3"));
  assert.deepEqual(input.map((r) => r.id), ["a1", "a2"], "入参不被修改");
  assert.deepEqual(archive.mergeArchive(null, mk("x1")).map((r) => r.id), ["x1"], "坏入参容错");
  assert.deepEqual(archive.mergeArchive([mk("a1")], null).map((r) => r.id), ["a1"], "坏记录容错");
});

/* ---------- 3. aggregateStats（§3.3） ---------- */

test("aggregateStats：按昵称聚合局数 / 胜场 / 胜率 / 角色分布，排除 isAI 座位", () => {
  const rec = (winner, players) => ({ v: 1, id: `r${Math.random()}`, winner, players });
  const list = [
    rec("good", [
      { seat: 1, nick: "甲", isAI: false, role: "seer", won: true },
      { seat: 2, nick: "AI-1", isAI: true, role: "werewolf", won: false },
      { seat: 3, nick: "乙", isAI: false, role: "werewolf", won: false },
    ]),
    rec("wolf", [
      { seat: 1, nick: "甲", isAI: false, role: "villager", won: false },
      { seat: 2, nick: "AI-2", isAI: true, role: "wolfking", won: true },
      { seat: 3, nick: "乙", isAI: false, role: "wolfking", won: true },
    ]),
  ];
  const stats = archive.aggregateStats(list);
  assert.equal(stats.length, 2, "AI 座位不进战绩（只剩甲乙）");
  const jia = stats.find((e) => e.nick === "甲");
  assert.equal(jia.games, 2);
  assert.equal(jia.wins, 1);
  assert.equal(jia.rate, 0.5);
  assert.deepEqual(jia.roles, { seer: 1, villager: 1 });
  const yi = stats.find((e) => e.nick === "乙");
  assert.equal(yi.games, 2);
  assert.equal(yi.wins, 1, "狼王 won=true（isWolf 口径计入胜场）");
  assert.deepEqual(yi.roles, { werewolf: 1, wolfking: 1 });
  // 局数降序排序；空 / 坏输入容错
  assert.ok(stats[0].games >= stats[1].games, "按局数降序");
  assert.deepEqual(archive.aggregateStats([]), []);
  assert.deepEqual(archive.aggregateStats(null), []);
  assert.deepEqual(archive.aggregateStats([null, { players: null }]), []);
});

/* ---------- 4. localStorage 薄 I/O（§3.1：静默容错 + Quota 减半重试） ---------- */

/** 内存 localStorage 顶替（node 无 webstorage）；maxLen 非空时模拟配额上限。 */
function shimLocalStorage(maxLen) {
  const mem = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => {
        if (maxLen != null && String(v).length > maxLen) throw new Error("QuotaExceededError");
        mem.set(k, String(v));
      },
      removeItem: (k) => mem.delete(k),
    },
  });
  return mem;
}

test("loadArchives / saveArchive：key 'ww_archive' 读写、坏 JSON 静默回 []、无 storage 可用", () => {
  // 无 localStorage 环境（纯函数用例前不 shim）：回 [] 不抛错
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  assert.deepEqual(archive.loadArchives(), []);
  assert.deepEqual(archive.saveArchive({ v: 1, id: "x", players: [] }), [], "无 storage 静默丢弃");

  const mem = shimLocalStorage();
  assert.deepEqual(archive.loadArchives(), [], "空库回 []");
  const saved = archive.saveArchive({ v: 1, id: "g1", ts: 1, players: [], log: [] });
  assert.equal(saved.length, 1);
  assert.deepEqual(archive.loadArchives().map((r) => r.id), ["g1"], "key 'ww_archive' 落盘");
  archive.saveArchive({ v: 1, id: "g2", ts: 2, players: [], log: [] });
  assert.deepEqual(archive.loadArchives().map((r) => r.id), ["g2", "g1"], "新档 unshift 在最前");

  // 坏 JSON 静默回 []（同 ww_solo 口径，不抛错）
  mem.set("ww_archive", "{bad json");
  assert.deepEqual(archive.loadArchives(), []);
  mem.set("ww_archive", "null");
  assert.deepEqual(archive.loadArchives(), []);
});

test("saveArchive：Quota 超限减半重试（丢最旧一半），仍失败静默丢弃", () => {
  const records = [];
  for (let i = 0; i < 30; i++) {
    records.push({
      v: 1,
      id: `g${String(i).padStart(2, "0")}`,
      ts: i,
      players: [],
      log: Array.from({ length: 40 }, () => ({ t: "speech", day: 1, seat: 1, text: "字".repeat(30) })),
    });
  }
  const full = JSON.stringify([records[29], ...records.slice(0, 29).reverse()].slice(0, 30)).length;
  /* 配额 = 全量写的 75%：接近满库时整写必超限 → 减半（≤ 半量）重试成功
     （自校准，不依赖具体字长；增量落库在配额线附近反复触发减半） */
  const quota = Math.ceil(full * 0.75);
  shimLocalStorage(quota);
  let latest = records[0];
  for (let i = 0; i < 30; i++) {
    latest = { ...records[i], id: `g${String(i).padStart(2, "0")}` };
    archive.saveArchive(latest);
  }
  const stored = archive.loadArchives();
  assert.ok(stored.length > 0 && stored.length < 30, `配额触顶后应减半落盘（实际 ${stored.length} 条）`);
  assert.equal(stored[0].id, latest.id, "减半丢最旧、最新保留");
  // 彻底存不下（配额小于单条减半）→ 静默丢弃不抛错
  shimLocalStorage(10);
  assert.deepEqual(archive.saveArchive(latest), [], "仍失败静默丢弃（不阻断终局复盘）");
});
