/* ============================================================
 * test/frontend.test.mjs —— 前端模块自检（node --test，零 DOM 依赖）
 * ------------------------------------------------------------
 * 覆盖：
 *   1. 全部 js 模块可在 node 直接 import（顶层不碰 document/localStorage）
 *   2. icons.js：SVG 常量形状 + 全站零 emoji 扫描（js/ + index.html + style.css）
 *   3. ai.js：parseReply（§5.1 宽容解析）/ toHistory / windowHistory（§5.4）
 *   4. 单机本地引擎整局：join → ready → start(solo) → 全部座位走 §8.4
 *      确定性回退推进，直到 revealed（验证 shared/game.js 的 solo 开关与
 *      app.js soloDrive 同款的驱动循环收敛）
 *   5. ui.js 玩家标签：scope 生命周期（换局清零 / 刷新复原）+ 校验上限
 * 运行：node --test test/frontend.test.mjs
 * ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as game from "../shared/game.js";
import * as ai from "../js/ai.js";
import { ICONS, icon } from "../js/icons.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- 1. 模块加载（骨架纪律的延续：8 个 ESM 模块加载验证） ---------- */

test("全部 js 模块可在 node 环境直接 import（顶层无 DOM 依赖）", async () => {
  for (const m of ["../js/icons.js", "../js/prompts.js", "../js/net.js", "../js/ai.js", "../js/ui.js", "../js/app.js"]) {
    await import(m); // 抛错即失败
  }
});

test("net.js 在无 localStorage 环境下可用（内存兜底）", async () => {
  const net = await import("../js/net.js");
  const me = net.me();
  assert.ok(typeof me.uid === "string" && me.uid.length > 0);
  assert.equal(net.loadSession(), null);
});

/* ---------- 2. 图标与零 emoji ---------- */

test("icons.js：全部为 SVG 字符串，缺名有兜底", () => {
  for (const [name, svg] of Object.entries(ICONS)) {
    assert.ok(svg.startsWith("<svg"), `${name} 不是 svg`);
    assert.ok(svg.endsWith("</svg>"), `${name} 未闭合`);
  }
  assert.ok(icon("__nope__").startsWith("<svg"));
});

/* emoji 区间（不含 CJK、中文标点与箭头符号 → 等排版字符） */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}]/u;

test("全站零 emoji（features.md §1）：js/ + index.html + style.css", () => {
  const files = ["index.html", "style.css", ...readdirSync(join(root, "js")).map((f) => `js/${f}`)];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    const m = text.match(EMOJI);
    assert.equal(m, null, `${f} 含 emoji / 符号字符：${m && m[0]}`);
  }
});

/* ---------- 3. ai.js 数据件（docs/ai-prompts.md §5.1 / §5.4） ---------- */

test("parseReply：发言类截断 250 字，空文本失败", () => {
  assert.deepEqual(ai.parseReply("speak", "  我觉得 3 号可疑。 "), { type: "speak", text: "我觉得 3 号可疑。" });
  const long = ai.parseReply("speak", "长".repeat(300));
  assert.equal(long.text.length, 250); // §5.8 硬上限（ADR-0012）
  assert.equal(ai.parseReply("speak", "   "), null);
});

test("parseReply：行动类 save / skip / 首个 1–9 数字（宽容序）", () => {
  assert.deepEqual(ai.parseReply("witch", "SAVE"), { type: "witch_move", move: "save" });
  assert.deepEqual(ai.parseReply("witch", "skip"), { type: "witch_move", move: "skip" });
  assert.deepEqual(ai.parseReply("witch", "毒 7 号"), { type: "witch_move", move: "poison", target: 7 });
  assert.equal(ai.parseReply("wolf", "我刀 4。"), null); // 狼阶段改走 parseWolfReply 两行解析
  assert.equal(ai.parseReply("seer", "skip"), null); // 验人不可跳过
  assert.deepEqual(ai.parseReply("hunter", "skip"), { type: "hunter_shoot", target: null });
  assert.deepEqual(ai.parseReply("vote", "  Skip。"), { type: "vote", target: null }); // 清洗后整串命中 skip
  assert.equal(ai.parseReply("vote", "我弃票吧"), null); // 非整串命中 → 无数字 → 解析失败走回退（与 room-logic 同款）
  assert.deepEqual(ai.parseReply("pk_vote", "6"), { type: "vote", target: 6 });
  assert.equal(ai.parseReply("vote", "我不知道"), null);
});

test("parseWolfReply：狼阶段两行格式（首行密聊、次行投票；与 room-logic 同口径）", () => {
  assert.deepEqual(ai.parseWolfReply("听我口型，白天别露馅。\n3"), { chat: "听我口型，白天别露馅。", target: 3 });
  assert.deepEqual(ai.parseWolfReply("过\n7"), { chat: null, target: 7 }); // 「过」= 无话可说
  assert.deepEqual(ai.parseWolfReply("5"), { chat: null, target: 5 }); // 纯数字单行 = 只投票
  assert.deepEqual(ai.parseWolfReply("先压 4 号"), { chat: "先压 4 号", target: null }); // 只聊天 → 投票走回退
  assert.deepEqual(ai.parseWolfReply(""), { chat: null, target: null });
});

test("toHistory：内核公开事件 → §1.3 history（平票拆 tie + exile）", () => {
  const h = ai.toHistory([
    { type: "day_announce", day: 1, dead: [4], peaceful: false },
    { type: "speech", day: 1, seat: 2, text: "我过。" },
    { type: "vote", day: 1, round: "main", seat: 1, target: 5 },
    { type: "vote_result", day: 1, round: "main", tally: [], exiled: null, pk: [3, 5] },
    { type: "vote_result", day: 1, round: "pk", tally: [], exiled: 5 },
    { type: "hunter_shoot", day: 1, seat: 5, target: 8 },
    { type: "game_start", day: 1, players: [] }, // 不进历史
  ]);
  assert.deepEqual(h, [
    { t: "deaths", day: 1, seats: [4] },
    { t: "speech", day: 1, seat: 2, text: "我过。" },
    { t: "vote", day: 1, voter: 1, target: 5 },
    { t: "tie", day: 1, seats: [3, 5] },
    { t: "exile", day: 1, seat: null },
    { t: "exile", day: 1, seat: 5 },
    { t: "hunter", day: 1, seat: 5, target: 8 },
  ]);
});

test("windowHistory：更早天数压 digest 且 dead 完整；超限从最旧丢弃", () => {
  const log = [];
  for (let day = 1; day <= 4; day++) {
    log.push({ t: "deaths", day, seats: [day] });
    log.push({ t: "speech", day, seat: 2, text: `第${day}天发言` });
    log.push({ t: "exile", day, seat: day + 4 });
  }
  const w = ai.windowHistory(log);
  const digests = w.filter((e) => e.t === "digest");
  assert.equal(digests.length, 1); // maxDay=4：第 2、3 个完整白天 + 当前第 4 天全量，仅第 1 天压缩
  assert.deepEqual(digests[0].dead, [1, 5]); // dead 完整列出该天全部出局座位（防存活推导出错）
  assert.deepEqual(w.filter((e) => e.t === "speech").map((e) => e.day), [2, 3, 4]);
  /* 超限裁剪：60 字节上限逼它丢到只剩最旧边界 */
  const tiny = ai.windowHistory(log, 60);
  assert.ok(JSON.stringify(tiny).length <= 200 && tiny.length >= 1);
});

/* ---------- 4. 单机本地引擎整局（内核 solo 开关 + 回退驱动收敛） ---------- */

test("单机：1 真人 + 8 AI 本地开局（solo 开关），回退驱动跑到 revealed", () => {
  /* 联机路径不变：不带 solo 仍拒绝 1 真人开局（§7.4） */
  let s = game.createInitialState();
  let r = game.advance(s, { type: "join", nick: "独行", uid: "u-solo" });
  assert.equal(r.error, null);
  r = game.advance(r.state, { type: "ready", seat: 1, ready: true });
  const denied = game.advance(r.state, { type: "start", seed: 42 });
  assert.equal(denied.error, "真人不足 3 人，无法开桌");

  /* solo:true 放行 1 真人（ADR-0003；DO 路由不下发该字段） */
  r = game.advance(r.state, { type: "start", seed: 42, solo: true });
  assert.equal(r.error, null);
  s = r.state;
  assert.equal(s.players.filter(Boolean).length, 9); // 原子补 8 AI
  assert.equal(s.players.filter((p) => p && p.isAI).length, 8);
  assert.equal(s.phase, "night");
  assert.equal(s.day, 1);
  assert.ok(s.players.every((p) => p && p.role)); // 已发牌

  /* app.js soloDrive 同款循环：所有座位（含真人位）走确定性回退推进 */
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
  assert.equal(s.phase, "revealed", "整局必须收敛（狼不可空刀 §5.10）");
  assert.ok(s.winner === "good" || s.winner === "wolf");
  assert.ok(log.length > 0, "公开事件账本非空（UI 事件流 / AI 历史窗口的数据源）");
  /* 账本必须能被 buildMessages 消费（前端 AI 请求组装链路） */
  const w = ai.windowHistory(log);
  assert.ok(Array.isArray(w));
});

test("单机身份卡：roleCardOf 按角色白名单出私有字段", () => {
  let s = game.advance(game.createInitialState(), { type: "join", nick: "独行", uid: "u1" }).state;
  s = game.advance(s, { type: "ready", seat: 1, ready: true }).state;
  s = game.advance(s, { type: "start", seed: 7, solo: true }).state;
  for (let seat = 1; seat <= 9; seat++) {
    const card = ai.roleCardOf(s, seat);
    assert.equal(card.seat, seat);
    const role = s.players[seat - 1].role;
    if (role === "werewolf") {
      assert.equal(card.role, "wolf");
      assert.equal(card.wolves.length, 3); // 狼必知全体队友（§1.2）
      assert.ok(card.wolves.includes(seat));
    }
    if (role === "seer") assert.deepEqual(card.checks, []);
    if (role === "witch") {
      assert.equal(card.antidote, true);
      assert.equal(card.poison, true);
      assert.equal(card.knifeTarget, undefined); // 非女巫行动夜不给刀口（§1.2）
    }
    if (role === "villager" || role === "hunter") {
      assert.equal(card.wolves, undefined, "平民 / 猎人不得带狼队信息");
    }
  }
});

/* ---------- 5. 玩家标签（私人笔记：scope 生命周期 + 校验 + localStorage 持久化） ---------- */

/** 内存 localStorage 顶替（node 无 webstorage；ui.js 调用时才读 global） */
function shimLocalStorage() {
  const mem = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
  });
  return mem;
}

test("玩家标签：增删开关 / 校验上限 / scope 切换清零与刷新恢复", async () => {
  const mem = shimLocalStorage();
  const ui = await import("../js/ui.js");

  ui.resetTags("solo");
  assert.deepEqual(ui.seatTags(3), []);

  /* 校验：空 / 超长 / 重复 */
  assert.match(ui.addSeatTag(3, "   "), /不能为空/);
  assert.match(ui.addSeatTag(3, "123456789"), /最多 8 字/);
  assert.equal(ui.addSeatTag(3, "狼"), null);
  assert.match(ui.addSeatTag(3, "狼"), /已有/);
  assert.equal(ui.addSeatTag(3, "查杀"), null);
  assert.deepEqual(ui.seatTags(3), ["狼", "查杀"]);

  /* toggle：已有 → 移除；满 6 个后拒绝新增 */
  assert.equal(ui.toggleSeatTag(3, "狼"), true);
  assert.deepEqual(ui.seatTags(3), ["查杀"]);
  for (const t of ["好人", "金水", "女巫", "猎人", "预言家"]) assert.equal(ui.addSeatTag(3, t), null);
  assert.match(ui.addSeatTag(3, "第七个"), /最多 6 个/);
  assert.equal(ui.toggleSeatTag(3, "好人"), true);
  assert.deepEqual(ui.seatTags(3), ["查杀", "金水", "女巫", "猎人", "预言家"]);

  /* 生命周期：切走 scope = 新对局（清零），切回 = 刷新复原（localStorage） */
  assert.equal(ui.addSeatTag(2, "好人"), null);
  ui.enterTagScope("ROOM2");
  assert.deepEqual(ui.seatTags(2), []);
  assert.deepEqual(ui.seatTags(3), []);
  ui.enterTagScope("solo");
  assert.deepEqual(ui.seatTags(2), ["好人"]);
  assert.deepEqual(ui.seatTags(3), ["查杀", "金水", "女巫", "猎人", "预言家"]);

  /* 坏数据兜底：解析失败当无标签，不抛错 */
  mem.set("ww_tags_BADJSON", "{bad json");
  ui.enterTagScope("BADJSON");
  assert.deepEqual(ui.seatTags(1), []);
});
