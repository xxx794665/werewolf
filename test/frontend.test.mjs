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
 *   6. 狼队密聊历史进提示词：夜里分组渲染 / 白天注入 / 非狼白名单忽略（§4.1.1 修订）
 *   7. ui.js 投票记录卡：voteHistory 公开事件流重组（§5.14：主/PK 分轮、
 *      tie 认领结果不被成对 exile{null} 覆盖、得票重算排序、平安日 / 进行中）
 *   8. ui.js 日志按天折叠：groupLogEvents 分组纯函数（按天升序、组内保序、
 *      成对 exile{null} 跳过、平安日不误删）（2026-10-05 试玩反馈）
 *   9. voteHistory 扩展（§2.4/§2.5，ADR-0014）：警长竞选轮次（elect/elect_pk、
 *      tie-pk 分轮界）、警长 1.5 票权重与移交 / 撕毁换权重
 *  10. groupLogEvents 吸收竞选 / 警长事件（additive，旧日志输出不变）
 *  11. js/archive.js 存档纯函数（§3.1，ADR-0015）：记录形状与 won 判定
 *     （狼王 = 狼侧）、mergeArchive 幂等与上限、aggregateStats 排除 AI
 *  12. roleCardOf 三新角色与新公开层字段（狼王 / 守卫 / 白痴板逐座位，
 *     board/sheriff/election/guardLast，§1.6 / 裁定 9–10）+ 旧形状兜底
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

/* ---------- 1. 模块加载（骨架纪律的延续：7 个 ESM 模块加载验证） ---------- */

test("全部 js 模块可在 node 环境直接 import（顶层无 DOM 依赖）", async () => {
  for (const m of ["../js/icons.js", "../js/prompts.js", "../js/net.js", "../js/ai.js", "../js/archive.js", "../js/ui.js", "../js/app.js"]) {
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

test("roleCardOf：三新角色与新公开层字段（狼王 / 守卫 / 白痴板逐座位）+ 旧形状兜底（§1.6 / 裁定 9–10）", () => {
  const start = (board, seed = 11) => {
    let s = game.advance(game.createInitialState(), { type: "join", nick: "独行", uid: "u1" }).state;
    s = game.advance(s, { type: "ready", seat: 1, ready: true }).state;
    const r = game.advance(s, { type: "start", seed, solo: true, board });
    assert.equal(r.error, null);
    return r.state;
  };
  /* 狼王板：狼王卡处处视作狼（wolves 含狼王座、密聊 / 狼票 / 队长齐备），board 落卡（§1.2 / §1.6） */
  const wkGame = start("wolfking");
  assert.equal(wkGame.phase, "night"); // 夜 1 狼阶段：狼私有字段齐出
  const wkSeat = wkGame.players.find((p) => p.role === "wolfking").seat;
  const wkCard = ai.roleCardOf(wkGame, wkSeat);
  assert.equal(wkCard.role, "wolfking", "契约名与内核同名（防漂移显式列出）");
  assert.equal(wkCard.board, "wolfking");
  assert.equal(wkCard.wolves.length, 3, "2 狼人 + 1 狼王全列");
  assert.ok(wkCard.wolves.includes(wkSeat));
  assert.deepEqual(wkCard.wolfChatLog, []);
  assert.deepEqual(wkCard.wolfVotes, {});
  assert.equal(typeof wkCard.captain, "number");
  assert.equal(wkCard.sheriff, null, "夜 1 未竞选 → 警长座位 null（裁定 9）");
  assert.equal("election" in wkCard, false, "非竞选期不带 election");
  assert.equal("guardLast" in wkCard, false, "非守卫座位不带 guardLast（裁定 10）");
  /* 守卫板：仅守卫座带 guardLast（昨晚守护座位，连守限制依据） */
  const gGame = start("guard");
  const gSeat = gGame.players.find((p) => p.role === "guard").seat;
  const gCard = ai.roleCardOf(gGame, gSeat);
  assert.equal(gCard.role, "guard");
  assert.equal(gCard.board, "guard");
  assert.equal(gCard.guardLast, null, "夜 1 未守护 → null");
  assert.equal(gCard.wolves, undefined, "守卫不带狼队信息");
  for (let seat = 1; seat <= 9; seat++) {
    if (seat === gSeat) continue;
    assert.equal("guardLast" in ai.roleCardOf(gGame, seat), false, `非守卫座位 ${seat} 不得带 guardLast`);
  }
  /* 白痴板：白痴卡契约名同名、无狼队私有信息（被动技能角色） */
  const iGame = start("idiot");
  const iCard = ai.roleCardOf(iGame, iGame.players.find((p) => p.role === "idiot").seat);
  assert.equal(iCard.role, "idiot");
  assert.equal(iCard.board, "idiot");
  assert.equal(iCard.wolves, undefined);
  /* 竞选中 + 警长已定：公开层 board / sheriff / election（裁定 9/11：主轮候选 + PK 台名单） */
  const elGame = start("standard", 13);
  elGame.phase = "day";
  elGame.subPhase = "elect_vote";
  elGame.sheriff = { seat: 5, election: { stage: "vote", run: {}, candidates: [2, 3], quit: {}, votes: { cast: {} }, queue: [], pkCandidates: [2, 3] } };
  const elCard = ai.roleCardOf(elGame, 2);
  assert.equal(elCard.sheriff, 5);
  assert.deepEqual(elCard.election, { candidates: [2, 3], pk: [2, 3] });
  /* 旧形状兜底（旧存档 / 部署窗口期旧房无 board/sheriff）：board 回 standard、sheriff null、无 election */
  const legacy = start("standard", 17);
  delete legacy.board;
  delete legacy.sheriff;
  const lCard = ai.roleCardOf(legacy, 1);
  assert.equal(lCard.board, "standard", "g.board 缺失兜底 standard（js/ai.js 客户端组卡路径）");
  assert.equal(lCard.sheriff, null);
  assert.equal("election" in lCard, false);
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

/* ---------- 6. 狼队密聊历史进提示词（§4.1.1 修订：跨夜保留，白天任务也带） ---------- */

test("狼人提示词：密聊日志夜里分组渲染、白天任务注入、非狼座位一律忽略", async () => {
  const { buildMessages } = await import("../shared/prompts.js");
  const history = [{ day: 1, t: "digest", text: "第 1 天平安日，无人出局。", dead: [] }];
  const card = {
    seat: 3,
    role: "wolf",
    wolves: [3, 7],
    wolfChatLog: [
      { n: 1, seat: 3, text: "昨晚刀 5 号，白天我来带节奏" },
      { n: 2, seat: 7, text: "今晚刀 1 号，我跳预言家" },
    ],
  };

  /* 夜里 wolf 任务：历史与今晚分组渲染（fold.day=1 → 第 2 夜） */
  const nightUser = buildMessages(history, card, "wolf")[1].content;
  assert.match(nightUser, /【狼队密聊历史（只有狼队可见，跨夜保留）】/);
  assert.match(nightUser, /第1夜 3 号：昨晚刀 5 号，白天我来带节奏/);
  assert.match(nightUser, /【今晚密聊】/);
  assert.match(nightUser, /7 号：今晚刀 1 号，我跳预言家/);

  /* 白天发言任务：注入全程密聊记录（与队友对口径的依据） */
  const dayUser = buildMessages(history, card, "speak")[1].content;
  assert.match(dayUser, /【狼队密聊记录（只有狼队可见/);
  assert.match(dayUser, /第2夜 7 号：今晚刀 1 号，我跳预言家/);

  /* 白名单：非狼座位带狼字段一律忽略，绝不进提示词 */
  const other = buildMessages(history, { seat: 4, role: "villager", wolfChatLog: [{ n: 1, seat: 4, text: "不该出现" }] }, "speak");
  assert.ok(!other[1].content.includes("狼队密聊"), "平民提示词绝不含狼队密聊");
  assert.ok(!other[1].content.includes("不该出现"));
});

/* ---------- 7. 投票记录卡：公开事件流 → 按轮次重组（§5.14） ---------- */

test("voteHistory：主/PK 分轮、tie 认领结果、得票重算排序、平安日与进行中", async () => {
  const ui = await import("../js/ui.js");
  const rounds = ui.voteHistory([
    { t: "speech", day: 1, seat: 2, text: "非投票事件忽略" },
    { t: "vote", day: 1, voter: 1, target: 5 },
    { t: "vote", day: 1, voter: 2, target: 5 },
    { t: "vote", day: 1, voter: 3, target: 2 },
    { t: "vote", day: 1, voter: 4, target: null },
    { t: "tie", day: 1, seats: [2, 5] },
    { t: "exile", day: 1, seat: null }, // 进 PK 时与 tie 成对发出，不得覆盖为平安日
    { t: "pk_speak", day: 1, seat: 2, text: "我才是好人" },
    { t: "vote", day: 1, voter: 1, target: 5 },
    { t: "vote", day: 1, voter: 4, target: 2 },
    { t: "vote", day: 1, voter: 6, target: 5 },
    { t: "exile", day: 1, seat: 5 },
    { t: "vote", day: 2, voter: 1, target: null },
    { t: "vote", day: 2, voter: 2, target: null },
    { t: "exile", day: 2, seat: null }, // 全弃 → 平安日
    { t: "vote", day: 3, voter: 1, target: 7 }, // 第 3 天进行中
  ]);
  assert.equal(rounds.length, 4);
  assert.deepEqual(rounds[0], {
    day: 1,
    kind: "main",
    votes: [
      { voter: 1, target: 5 },
      { voter: 2, target: 5 },
      { voter: 3, target: 2 },
      { voter: 4, target: null },
    ],
    outcome: { type: "pk", seats: [2, 5] },
    sheriff: null, // 无 sheriff 事件的旧日志：不加权（§2.4 权重字段，恒 null）
    tally: [
      { seat: 5, count: 2 },
      { seat: 2, count: 1 },
    ],
  });
  assert.equal(rounds[1].kind, "pk"); // tie 后的同日 vote 进 PK 轮
  assert.deepEqual(rounds[1].outcome, { type: "exile", seat: 5 });
  assert.deepEqual(rounds[1].tally, [
    { seat: 5, count: 2 },
    { seat: 2, count: 1 },
  ]);
  assert.equal(rounds[2].kind, "main"); // 换天回到主投票
  assert.deepEqual(rounds[2].outcome, { type: "peaceful" });
  assert.deepEqual(rounds[2].tally, []); // 全员弃票 → 得票榜为空
  assert.equal(rounds[3].outcome, null); // 无 tie/exile 收尾 = 进行中
  assert.deepEqual(ui.voteHistory([]), []);
  assert.deepEqual(ui.voteHistory(null), []);
});

/* ---------- 9. voteHistory 扩展：警长竞选轮次 + 警长 1.5 票权重（§2.4 / §2.5，ADR-0014） ---------- */

test("voteHistory：竞选轮按天分组与 tie-pk 分轮界、elected 收尾、警长票计 1.5、移交换权重", async () => {
  const ui = await import("../js/ui.js");
  const rounds = ui.voteHistory([
    { t: "elect_vote", day: 1, voter: 4, target: 2 },
    { t: "elect_vote", day: 1, voter: 5, target: 2 },
    { t: "elect_vote", day: 1, voter: 6, target: 7 },
    { t: "elect_vote", day: 1, voter: 8, target: null }, // 竞选弃票
    { t: "sheriff", day: 1, kind: "tie-pk", pk: [2, 7] }, // 竞选主轮平票 → PK 分界
    { t: "elect_vote", day: 1, voter: 4, target: 2 },
    { t: "elect_vote", day: 1, voter: 5, target: 7 },
    { t: "sheriff", day: 1, kind: "elected", seat: 2 }, // 2 号当选
    { t: "vote", day: 1, voter: 2, target: 8 }, // 警长票 1.5
    { t: "vote", day: 1, voter: 3, target: 8 },
    { t: "exile", day: 1, seat: 8 },
    { t: "sheriff", day: 2, kind: "transfer", from: 2, to: 5 }, // 警徽移交 5 号
    { t: "vote", day: 2, voter: 5, target: 9 }, // 新警长票 1.5
    { t: "vote", day: 2, voter: 6, target: 9 },
    { t: "exile", day: 2, seat: 9 },
  ]);
  assert.equal(rounds.length, 4);
  /* 竞选主轮：kind elect、tie-pk 收尾、警长未产生不加权 */
  assert.deepEqual(rounds[0], {
    day: 1,
    kind: "elect",
    votes: [
      { voter: 4, target: 2 },
      { voter: 5, target: 2 },
      { voter: 6, target: 7 },
      { voter: 8, target: null },
    ],
    outcome: { type: "pk", seats: [2, 7] },
    sheriff: null,
    tally: [
      { seat: 2, count: 2 },
      { seat: 7, count: 1 },
    ],
  });
  /* 竞选 PK 轮：kind elect_pk、elected 收尾 */
  assert.equal(rounds[1].kind, "elect_pk");
  assert.deepEqual(rounds[1].outcome, { type: "elected", seat: 2 });
  assert.deepEqual(rounds[1].tally, [
    { seat: 2, count: 1 },
    { seat: 7, count: 1 },
  ]);
  /* 放逐主投票：警长 2 号一票计 1.5（§2.4） */
  assert.equal(rounds[2].kind, "main");
  assert.equal(rounds[2].sheriff, 2);
  assert.deepEqual(rounds[2].tally, [{ seat: 8, count: 2.5 }]);
  /* 警徽移交后：5 号接任警长，其票计 1.5；2 号不再加权 */
  assert.equal(rounds[3].sheriff, 5);
  assert.deepEqual(rounds[3].tally, [{ seat: 9, count: 2.5 }]);
});

test("voteHistory：竞选无人当选 / 警徽撕毁后不再加权", async () => {
  const ui = await import("../js/ui.js");
  const rounds = ui.voteHistory([
    { t: "elect_vote", day: 1, voter: 4, target: 2 },
    { t: "sheriff", day: 1, kind: "none" }, // 再平无警长
    { t: "vote", day: 1, voter: 2, target: 8 },
    { t: "exile", day: 1, seat: 8 },
  ]);
  assert.equal(rounds[0].kind, "elect");
  assert.deepEqual(rounds[0].outcome, { type: "none" });
  assert.equal(rounds[1].sheriff, null); // 无警长 → 1 票
  assert.deepEqual(rounds[1].tally, [{ seat: 8, count: 1 }]);
  const destroyed = ui.voteHistory([
    { t: "sheriff", day: 1, kind: "elected", seat: 3 },
    { t: "sheriff", day: 2, kind: "destroy", from: 3 }, // 撕毁 → 本局无警长
    { t: "vote", day: 2, voter: 3, target: 6 },
    { t: "exile", day: 2, seat: 6 },
  ]);
  assert.equal(destroyed[0].sheriff, null);
  assert.deepEqual(destroyed[0].tally, [{ seat: 6, count: 1 }]);
});

/* ---------- 10. groupLogEvents 吸收警长竞选事件（§2.5 additive：旧日志输出不变） ---------- */

test("groupLogEvents：elect_run / elect_speech / elect_withdraw / elect_vote / sheriff 按天归组", async () => {
  const ui = await import("../js/ui.js");
  const groups = ui.groupLogEvents([
    { t: "deaths", day: 1, seats: [] },
    { t: "elect_run", day: 1, seat: 2, run: true },
    { t: "elect_speech", day: 1, seat: 2, text: "我是好人" },
    { t: "elect_withdraw", day: 1, seat: 3, quit: true },
    { t: "elect_vote", day: 1, voter: 4, target: 2 },
    { t: "sheriff", day: 1, kind: "elected", seat: 2 },
    { t: "sheriff", day: 2, kind: "transfer", from: 2, to: 5 },
  ]);
  assert.deepEqual(groups.map((g) => [g.day, g.events.length]), [[1, 6], [2, 1]]);
  assert.equal(groups[0].events[5].kind, "elected");
});

/* ---------- 11. 本地存档纯函数（§3.1，ADR-0015）：形状 / won 判定 / 去重上限 / 真人聚合 ---------- */

test("archive：buildArchiveRecord 形状与 won 判定（狼王 = 狼侧）、mergeArchive 幂等与上限、aggregateStats 排除 AI", async () => {
  const arc = await import("../js/archive.js");
  const state = {
    board: "wolfking",
    seed: 1234,
    winner: "wolf",
    reason: "parity",
    day: 3,
    players: [
      { seat: 1, nick: "阿明", isAI: false, role: "wolfking" },
      { seat: 2, nick: "AI-1", isAI: true, role: "seer", death: { day: 2, cause: "blade" } },
      { seat: 3, nick: "阿明", isAI: false, role: "villager", death: { day: 3, cause: "exile" } },
    ],
  };
  const rec = arc.buildArchiveRecord(state, [{ t: "deaths", day: 1, seats: [] }], { mode: "solo" });
  assert.equal(rec.id, "solo:1234"); // 缺省按 seed 推导（幂等键）
  assert.equal(rec.board.name, "狼王板");
  assert.equal(rec.players[0].won, true); // 狼王 = 狼侧（ADR-0013）
  assert.equal(rec.players[1].won, false);
  assert.equal(rec.players[1].death.day, 2); // death 透传
  assert.equal(rec.log.length, 1);
  /* 联机形状（快照 players 无 seed）+ 显式 id */
  const rec2 = arc.buildArchiveRecord({ winner: "good", day: 5, players: [] }, [], { mode: "online", id: "online:ABC234" });
  assert.equal(rec2.id, "online:ABC234");
  assert.equal(rec2.board.id, "standard"); // 无 board 字段 → 标准板兜底（旧房兼容）
  /* mergeArchive：同 id 去重幂等 + unshift + 上限 30 丢最旧 */
  const once = arc.mergeArchive([], rec);
  assert.equal(arc.mergeArchive(once, rec).length, 1);
  let list = [];
  for (let i = 0; i < 35; i++) list = arc.mergeArchive(list, { ...rec, id: `solo:${i}` });
  assert.equal(list.length, 30);
  assert.equal(list[0].id, "solo:34"); // 最新在前
  assert.equal(list.some((r) => r.id === "solo:4"), false); // 最旧被丢
  /* aggregateStats：同昵称跨记录聚合、排除 isAI、胜率 */
  const stats = arc.aggregateStats([rec]);
  assert.equal(stats.length, 1);
  assert.deepEqual(stats[0].nick, "阿明");
  assert.equal(stats[0].games, 2); // 同昵称两名真人座位各计一局
  assert.equal(stats[0].wins, 1);
  assert.equal(stats[0].rate, 0.5);
  assert.equal(stats[0].roles.wolfking, 1);
});

/* ---------- 8. 日志按天折叠：groupLogEvents 分组纯函数（2026-10-05 试玩反馈） ---------- */

test("groupLogEvents：按天升序分组、组内保序、成对 exile{null} 跳过、平安日不误删", async () => {
  const ui = await import("../js/ui.js");
  const groups = ui.groupLogEvents([
    { t: "deaths", day: 1, seats: [3] },
    { t: "speech", day: 1, seat: 1, text: "a" },
    { t: "vote", day: 1, voter: 1, target: 3 },
    { t: "tie", day: 1, seats: [3, 5] },
    { t: "exile", day: 1, seat: null }, // 主投票平票进 PK 时成对发出 → 跳过
    { t: "pk_speak", day: 1, seat: 5, text: "pk" }, // 同日 PK 发言仍归同组
    { t: "exile", day: 1, seat: 5 },
    { t: "deaths", day: 2, seats: [] },
    { t: "speech", day: 2, seat: 2, text: "b" },
  ]);
  assert.deepEqual(groups.map((g) => [g.day, g.events.length]), [[1, 6], [2, 2]]);
  assert.ok(!groups[0].events.some((e) => e.t === "exile" && e.seat == null), "成对 exile{null} 不进组");
  assert.equal(groups[0].events[0].t, "deaths"); // 组内保持事件流原序
  assert.equal(groups[0].events[5].t, "exile");
  /* 无成对 tie 的 exile{null} = 真平安日，不得误删 */
  const peaceful = ui.groupLogEvents([
    { t: "vote", day: 1, voter: 1, target: null },
    { t: "exile", day: 1, seat: null },
  ]);
  assert.equal(peaceful.length, 1);
  assert.equal(peaceful[0].events.length, 2);
  assert.deepEqual(ui.groupLogEvents([]), []);
  assert.deepEqual(ui.groupLogEvents(null), []);
});
