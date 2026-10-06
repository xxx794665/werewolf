/* ============================================================
 * test/game-core.test.mjs —— shared/game.js 内核测试（node --test 自动发现）
 * 口径对照 docs/features.md（冻结版）：§3 板子 / §4 昼夜流程 /
 *   §4.2.6 平票 PK / §5 关键口径 / §5.7 胜负 / §7.4–7.5 AI 补位 / §8.4 回退；
 *   板子与三新角色（狼王 / 守卫 / 白痴，ADR-0013）、警长系统（ADR-0014）用例段见文末；
 *   多板整局收敛（§5.3 整局验收面）与旧态兼容（部署过渡防回归）段见文末。
 * 覆盖：发牌、夜晚结算、平票、胜负、补位各至少一例，外加各非平凡分支。
 * 固定种子（mulberry32）保证全部用例可复现。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../shared/game.js';
import { PERSONAS } from '../shared/prompts.js';

const adv = (s, a) => game.advance(s, a);
const at = (s, seat) => s.players[seat - 1];
const seatOf = (s, role) => s.players.find((p) => p && p.role === role).seat;
const seatsOf = (s, role) => s.players.filter((p) => p && p.role === role).map((p) => p.seat);

/** 建房 → 加入 → 全员准备 → start（带种子，可选板子）。 */
function newRoom(nicks, seed = 42, board) {
  let s = game.createInitialState();
  nicks.forEach((nick, i) => {
    const r = adv(s, { type: 'join', nick, uid: `u${i + 1}` });
    assert.equal(r.error, null, `join 不应失败：${r.error}`);
    s = r.state;
  });
  for (let seat = 1; seat <= nicks.length; seat++) {
    const r = adv(s, { type: 'ready', seat, ready: true });
    assert.equal(r.error, null, `ready 不应失败：${r.error}`);
    s = r.state;
  }
  const r = adv(s, { type: 'start', seed, ...(board !== undefined ? { board } : null) });
  assert.equal(r.error, null, `start 不应失败：${r.error}`);
  return { state: r.state, events: r.events };
}

/** §4.1.1 狼队全员投票定刀：所有存活狼（含狼王，isWolf 口径）依次投 target（跳过已投者），返回最终结果。 */
function wolfVoteAll(s, target) {
  let r = null;
  for (const w of s.players.filter((p) => p && p.alive && game.isWolf(p.role)).map((p) => p.seat)) {
    if (s.night && s.night.wolfVotes[w] !== undefined) continue; // 已被回退或先前用例投过
    r = adv(s, { type: 'wolf_target', seat: w, target });
    assert.equal(r.error, null, `wolf_target(${w}) 不应失败：${r.error}`);
    s = r.state;
  }
  return r;
}

/** 打完一整夜（狼刀 → 守卫 → 验人 → 用药 → 结算）。返回最后一次 advance 的结果（含天亮公告）。 */
function playNight(s, { blade, check, guardTarget, witchMove } = {}) {
  let r = wolfVoteAll(s, blade);
  assert.equal(r.error, null, `wolf_target 不应失败：${r.error}`);
  s = r.state;
  if (s.subPhase === 'guard') {
    // §1.3 守卫步（ADR-0013）：缺省守一个「非自己也非上晚目标」的存活座（守卫板用例都过此步）
    const g = seatOf(s, 'guard');
    const last = s.guard && s.guard.last;
    const def = s.players.find((p) => p.alive && p.seat !== g && p.seat !== last);
    const target = guardTarget ?? (def ? def.seat : g);
    r = adv(s, { type: 'guard_protect', seat: g, target });
    assert.equal(r.error, null, `guard_protect 不应失败：${r.error}`);
    s = r.state;
  }
  if (s.subPhase === 'seer') {
    const seer = seatOf(s, 'seer');
    const target = check ?? s.players.find((p) => p.alive && p.seat !== seer).seat;
    r = adv(s, { type: 'seer_check', seat: seer, target });
    assert.equal(r.error, null, `seer_check 不应失败：${r.error}`);
    s = r.state;
  }
  if (s.subPhase === 'witch') {
    r = adv(s, { type: 'witch_move', seat: seatOf(s, 'witch'), ...witchMove });
    assert.equal(r.error, null, `witch_move 不应失败：${r.error}`);
    s = r.state;
  }
  return r;
}

/** 用确定性回退自动跑完白天链（遗言 / 竞选各阶段 / 发言 / PK 发言 / 警徽处置），
 *  停在 vote / pk_vote / 夜 / 终局等非回退阶段。day 1 竞选回退 = 全员不上警（无警长语义）。 */
function autoSpeak(s) {
  const events = [];
  const DRIVE = [
    'lastwords', 'exile_lastwords', 'speak', 'pk_speak',
    'elect_join', 'elect_withdraw', 'elect_campaign', 'elect_pk_speak', 'elect_vote', 'elect_pk_vote', 'badge',
  ];
  let guard = 0;
  while (DRIVE.includes(s.subPhase)) {
    const seat = game.pendingSeat(s);
    assert.notEqual(seat, null, `autoSpeak 阶段 ${s.subPhase} 必须有待行动座位`);
    const r = game.applyFallback(s, seat);
    assert.equal(r.error, null, `回退 @${seat}/${s.subPhase} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
    guard += 1;
    assert.ok(guard < 300, 'autoSpeak 必须终止');
  }
  return { state: s, events };
}

/** 用确定性回退驱动 day 1 竞选至出结论（默认全员不上警 → 本局无警长），停在 speak 等后续阶段。 */
function autoElect(s) {
  const events = [];
  const ELECT = ['elect_join', 'elect_withdraw', 'elect_campaign', 'elect_pk_speak', 'elect_vote', 'elect_pk_vote', 'badge'];
  let guard = 0;
  while (ELECT.includes(s.subPhase)) {
    const seat = game.pendingSeat(s);
    assert.notEqual(seat, null, `autoElect 阶段 ${s.subPhase} 必须有待行动座位`);
    const r = game.applyFallback(s, seat);
    assert.equal(r.error, null, `竞选回退 @${seat}/${s.subPhase} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
    guard += 1;
    assert.ok(guard < 60, 'autoElect 必须终止');
  }
  return { state: s, events };
}

/** 逐人投票（对象：座位 → 目标或 null 弃票）；最后一票触发计票。 */
function castVotes(s, votesMap) {
  const events = [];
  for (const [seat, target] of Object.entries(votesMap)) {
    const r = adv(s, { type: 'vote', seat: Number(seat), target });
    assert.equal(r.error, null, `vote 不应失败 @${seat}：${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** 平安夜（女巫救刀）→ 白天发言完毕，停在 vote（day 1 竞选回退为全员不上警，保「无警长」语义）。 */
function toDayVote(s, blade) {
  const night = playNight(s, { blade, witchMove: { move: 'save' } });
  assert.equal(night.events.find((e) => e.type === 'day_announce').peaceful, true, '应是平安夜');
  const day = autoSpeak(night.state);
  assert.equal(day.state.subPhase, 'vote');
  return day.state;
}

/* ---------------- 发牌（§3） ---------------- */

test('发牌：同种子同发牌、异种子不同；板子构成 3狼3民预女猎；AI 座位按补位顺序命名', () => {
  const a = newRoom(['张三', '李四', '王五'], 42);
  const b = newRoom(['张三', '李四', '王五'], 42);
  const c = newRoom(['张三', '李四', '王五'], 4242);
  const roles = a.state.players.map((p) => p.role);
  assert.deepEqual(roles, b.state.players.map((p) => p.role), '同种子必须同发牌');
  assert.notDeepEqual(roles, c.state.players.map((p) => p.role), '异种子应得到不同发牌');
  const count = {};
  for (const r of roles) count[r] = (count[r] || 0) + 1;
  assert.deepEqual(count, game.BOARDS.standard.roles, '角色构成必须等于板子定义（缺省 standard）');
  assert.equal(a.state.board, 'standard', '缺省板子落账');
  assert.equal(a.state.players.length, game.SEAT_COUNT);
  assert.equal(a.state.phase, 'night');
  assert.equal(a.state.day, 1);
  assert.equal(a.state.subPhase, 'wolf');
  // §7.5：AI-1…AI-6 按补位顺序命名（开局座位洗牌后座位号与补位顺序解耦，按集合断言）
  assert.deepEqual(
    a.state.players.filter((p) => p.isAI).map((p) => p.nick).sort(),
    ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6']
  );
  assert.equal(a.state.players.filter((p) => p.isAI).length, 6);
  assert.equal(a.state.players.filter((p) => !p.isAI).length, 3);
  // game_start 事件不带 role（暗牌）
  const gs = a.events.find((e) => e.type === 'game_start');
  assert.equal(gs.players.length, 9);
  assert.ok(gs.players.every((p) => !('role' in p)));
});

test('开局座位洗牌（2026-10-05 试玩反馈）：真人座位随 seed 分布、seat↔index 双射、同 seed 可复现、名册对随玩家迁移', () => {
  const start = (seed, roster) => {
    let s = game.advance(game.createInitialState(), { type: 'join', nick: '独行', uid: 'u-x' }).state;
    s = adv(s, { type: 'ready', seat: 1, ready: true }).state;
    const r = adv(s, { type: 'start', seed, solo: true, roster });
    assert.equal(r.error, null);
    return r.state;
  };
  const humanSeats = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const s = start(seed);
    assert.equal(s.players.length, 9);
    s.players.forEach((p, i) => assert.equal(p.seat, i + 1, '洗牌后 seat === index + 1 不变式'));
    assert.equal(s.players.filter((p) => !p.isAI).length, 1);
    const cnt = {};
    for (const p of s.players) cnt[p.role] = (cnt[p.role] || 0) + 1;
    assert.deepEqual(cnt, game.BOARDS.standard.roles, '洗牌不改角色构成');
    humanSeats.add(s.players.find((p) => !p.isAI).seat);
  }
  assert.ok(humanSeats.size > 1, '多个 seed 下真人座位不应固定');
  // 同 seed 完全可复现（座次 + 发牌）
  const key = (st) => st.players.map((p) => `${p.seat}:${p.nick}:${p.role}`).join('|');
  assert.equal(key(start(777)), key(start(777)), '同 seed 座次与发牌完全可复现');
  // 名册对随玩家迁移：AI 网名与人格不因洗牌拆对
  const named = start(888, [{ nick: '逻辑闭环怪', persona: '盘逻辑' }]).players.find((p) => p.nick === '逻辑闭环怪');
  assert.equal(named.persona, '盘逻辑');
  assert.ok(named.isAI);
});

/* ---------------- 板子（§1.1 / ADR-0013） ---------------- */

test('板子：四板发牌构成各 9 张且角色数与 BOARDS 一致；board/seed 落账；旧 BOARD 导出已删除', () => {
  for (const [id, b] of Object.entries(game.BOARDS)) {
    const { state: s } = newRoom(['甲', '乙', '丙'], 42, id);
    assert.equal(s.board, id, `板子 id 落账：${id}`);
    assert.equal(s.players.length, game.SEAT_COUNT);
    const cnt = {};
    for (const p of s.players) cnt[p.role] = (cnt[p.role] || 0) + 1;
    assert.deepEqual(cnt, b.roles, `${id} 发牌构成必须等于板子定义`);
  }
  // 缺省 standard（旧客户端 / 旧房不传 board 兼容）+ seed 落账
  const def = newRoom(['甲', '乙', '丙'], 42);
  assert.equal(def.state.board, 'standard');
  assert.equal(def.state.seed, 42, '发牌种子落账（存档 / 回放 / 测试复现）');
  const cnt = {};
  for (const p of def.state.players) cnt[p.role] = (cnt[p.role] || 0) + 1;
  assert.deepEqual(cnt, game.BOARDS.standard.roles);
  assert.equal(game.DEFAULT_BOARD, 'standard');
  assert.equal(game.BOARD, undefined, '旧单板常量 BOARD 导出已删除（§1.1）');
  // 同板同种子可复现
  const a = newRoom(['甲', '乙', '丙'], 42, 'wolfking');
  const b = newRoom(['甲', '乙', '丙'], 42, 'wolfking');
  assert.deepEqual(a.state.players.map((p) => p.role), b.state.players.map((p) => p.role), '同板同种子同发牌');
});

test('板子：非法 board 拒绝开局且状态原样返回', () => {
  let s = game.createInitialState();
  s = adv(s, { type: 'join', nick: '我', uid: 'u1' }).state;
  s = adv(s, { type: 'ready', seat: 1, ready: true }).state;
  for (const bad of ['nope', '', 42, { x: 1 }]) {
    const r = adv(s, { type: 'start', seed: 42, solo: true, board: bad });
    assert.equal(r.error, '未知板子', `非法 board 应拒绝：${JSON.stringify(bad)}`);
    assert.equal(r.state, s, '拒绝时状态原样返回（纯函数）');
  }
  // null 视同缺省（旧调用方 JSON null 兼容），不拒绝
  const okStart = adv(s, { type: 'start', seed: 42, solo: true, board: null });
  assert.equal(okStart.error, null, 'board:null 视同缺省 standard');
  assert.equal(okStart.state.board, 'standard');
});

test('isWolf / votersOf 助手：狼王判狼、翻牌白痴出局投票权（§1.2 / §1.4）', () => {
  assert.equal(game.isWolf('werewolf'), true);
  assert.equal(game.isWolf('wolfking'), true);
  for (const r of ['villager', 'seer', 'witch', 'hunter', 'guard', 'idiot', null, undefined]) {
    assert.equal(game.isWolf(r), false, `${r} 不应判狼`);
  }
  const s = game.createInitialState();
  s.players = [
    { seat: 1, role: 'villager', alive: true },
    { seat: 2, role: 'idiot', alive: true }, // 未翻牌白痴：保留投票权
    { seat: 3, role: 'idiot', alive: true, idiotRevealed: true }, // 翻牌白痴：出局
    { seat: 4, role: 'werewolf', alive: false }, // 死者出局
    { seat: 5, role: 'seer', alive: true },
    null, null, null, null,
  ];
  assert.deepEqual(game.votersOf(s), [1, 2, 5], 'votersOf = 存活且非翻牌白痴');
});

/* ---------------- 夜晚结算（§4.1 / §5.2 / §5.3） ---------------- */

test('夜晚结算：刀口被救且无毒 → 平安夜公告，无遗言直接进入白天发言', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const victim = seatsOf(s0, 'villager')[0];
  const r = playNight(s0, { blade: victim, witchMove: { move: 'save' } });
  const ann = r.events.find((e) => e.type === 'day_announce');
  assert.equal(ann.day, 1);
  assert.deepEqual(ann.dead, []);
  assert.equal(ann.peaceful, true);
  assert.equal(r.state.phase, 'day');
  assert.equal(r.state.subPhase, 'elect_join', '无死亡 → 无遗言 → day 1 先上警表态（§2.2 时序，ADR-0014）');
  const day = autoSpeak(r.state); // 竞选回退 = 全员不上警 → 无警长 → 发言
  assert.equal(day.state.subPhase, 'vote', '竞选 → 发言 → 投票');
  assert.ok(day.state.sheriff.seat === null && day.state.sheriff.electDone === true, '全员不上警 → 本局无警长');
  assert.ok(r.state.players.every((p) => p.alive));
  assert.equal(r.state.witch.antidote, 0, '解药全局一瓶，用掉即清零');
  assert.equal(r.state.witch.poison, 1);
});

test('夜晚结算：刀与毒各杀一人 → 天亮一次性公布双死者并进首夜遗言；夜间子阶段不产生公开事件', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolf = seatsOf(s0, 'werewolf')[0];
  const v1 = seatsOf(s0, 'villager')[0];
  const v2 = seatsOf(s0, 'villager')[1];
  const r1 = wolfVoteAll(s0, v1);
  assert.equal(r1.error, null);
  assert.deepEqual(r1.events, [], '狼人行动不产生公开事件（§4.1.5）');
  const r2 = adv(r1.state, { type: 'seer_check', seat: seatOf(s0, 'seer'), target: v2 });
  assert.equal(r2.error, null);
  assert.deepEqual(r2.events, [], '预言家行动不产生公开事件');
  const r3 = adv(r2.state, { type: 'witch_move', seat: seatOf(s0, 'witch'), move: 'poison', target: wolf });
  assert.equal(r3.error, null);
  const ann = r3.events.find((e) => e.type === 'day_announce');
  assert.deepEqual(ann.dead, [v1, wolf].sort((x, y) => x - y), '公布全部死者、不区分先后、按座位序');
  assert.equal(ann.peaceful, false);
  assert.equal(r3.state.subPhase, 'lastwords');
  assert.deepEqual(r3.state.queue, ann.dead, '首夜死者有遗言（§4.2.3）');
  assert.equal(at(r3.state, v1).death.cause, 'blade');
  assert.equal(at(r3.state, wolf).death.cause, 'poison');
});

test('夜晚结算：刀口与毒药重合 → 只死一人（§4.1.4）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const v1 = seatsOf(s0, 'villager')[0];
  const r = playNight(s0, { blade: v1, witchMove: { move: 'poison', target: v1 } });
  assert.deepEqual(r.events.find((e) => e.type === 'day_announce').dead, [v1]);
  assert.equal(r.state.players.filter((p) => !p.alive).length, 1);
});

test('夜晚结算：猎人死于毒（即使同时被刀）无枪；死于刀进入 night_hunter 开枪槽位（先于遗言）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const hunter = seatOf(s0, 'hunter');
  const rPoison = playNight(s0, { blade: hunter, witchMove: { move: 'poison', target: hunter } });
  assert.equal(rPoison.state.subPhase, 'lastwords', '毒死猎人不进入开枪槽位');
  assert.equal(rPoison.state.pendingHunter, null);
  assert.equal(at(rPoison.state, hunter).death.cause, 'poison');
  const rBlade = playNight(s0, { blade: hunter, witchMove: { move: 'skip' } });
  assert.equal(rBlade.state.subPhase, 'night_hunter');
  assert.equal(rBlade.state.pendingHunter, hunter);
  assert.equal(rBlade.events.filter((e) => e.type === 'day_announce').length, 1, '公告已发生');
  assert.equal(rBlade.events.filter((e) => e.type === 'last_words').length, 0, '开枪槽位先于遗言');
});

test('夜亡猎人：开枪立即追加公布并再判胜负，枪杀者无遗言；放弃开枪只翻牌', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const hunter = seatOf(s0, 'hunter');
  const wolf = seatsOf(s0, 'werewolf')[0];
  const r = playNight(s0, { blade: hunter, witchMove: { move: 'skip' } });
  const s1 = r.state;
  const r2 = adv(s1, { type: 'hunter_shoot', seat: hunter, target: wolf });
  assert.equal(r2.error, null);
  assert.deepEqual(r2.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot']);
  assert.equal(r2.events[0].seat, hunter);
  assert.equal(r2.events[1].target, wolf);
  assert.equal(at(r2.state, wolf).alive, false);
  assert.equal(at(r2.state, wolf).death.cause, 'shot');
  assert.equal(r2.state.subPhase, 'lastwords', '未分胜负 → 首夜遗言');
  assert.deepEqual(r2.state.queue, [hunter], '遗言只含夜死者猎人，被枪杀者无遗言（§5.4）');
  const r3 = adv(s1, { type: 'hunter_shoot', seat: hunter, target: null });
  assert.deepEqual(r3.events.map((e) => e.type), ['hunter_flip', 'hunter_skip']);
  assert.equal(r3.state.subPhase, 'lastwords');
});

test('女巫口径：首夜可自救；解药耗尽不再看刀口也救不了；次夜刀自己不可自救；同晚至多一瓶', () => {
  // 局 A：首夜自救（用掉解药）→ 平安日 → 第二夜解药已尽
  const roomA = newRoom(['张三', '李四', '王五'], 42);
  const witchA = seatOf(roomA.state, 'witch');
  const n1 = playNight(roomA.state, { blade: witchA, witchMove: { move: 'save' } });
  assert.equal(n1.events.find((e) => e.type === 'day_announce').peaceful, true, '首夜可自救');
  const day = autoSpeak(n1.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = null;
  const d1 = castVotes(day.state, votes); // 全员弃票 → 平安日 → 第二夜
  assert.equal(d1.state.phase, 'night');
  assert.equal(d1.state.day, 2);
  const w1 = wolfVoteAll(d1.state, witchA);
  const w2 = adv(w1.state, { type: 'seer_check', seat: seatOf(w1.state, 'seer'), target: seatsOf(roomA.state, 'villager')[0] });
  assert.equal(w2.state.subPhase, 'witch');
  assert.equal(game.witchSeesBlade(w2.state), null, '解药耗尽后不再显示刀口（§5.2）');
  const w3 = adv(w2.state, { type: 'witch_move', seat: witchA, move: 'save' });
  assert.equal(w3.error, '解药已用完');
  assert.equal(w3.state, w2.state, '校验失败必须原样返回状态');

  // 局 B：首夜跳过（解药在手）→ 次夜刀自己 → 不可自救
  const roomB = newRoom(['张三', '李四', '王五'], 43);
  const witchB = seatOf(roomB.state, 'witch');
  const nb1 = playNight(roomB.state, { blade: seatsOf(roomB.state, 'villager')[0], witchMove: { move: 'skip' } });
  const dayB = autoSpeak(nb1.state);
  const votesB = {};
  for (const p of dayB.state.players) if (p.alive) votesB[p.seat] = null;
  const d1b = castVotes(dayB.state, votesB);
  const wb1 = wolfVoteAll(d1b.state, witchB);
  const wb2 = adv(wb1.state, { type: 'seer_check', seat: seatOf(wb1.state, 'seer'), target: seatsOf(roomB.state, 'villager')[1] });
  assert.equal(game.witchSeesBlade(wb2.state), witchB, '解药在手时女巫可见刀口');
  const wb3 = adv(wb2.state, { type: 'witch_move', seat: witchB, move: 'save' });
  assert.equal(wb3.error, '首夜之后女巫不可自救');

  // 同晚至多一瓶：一个动作后立即结算，再提交任何女巫动作都被拒绝
  const nb2 = playNight(roomB.state, { blade: seatsOf(roomB.state, 'villager')[0], witchMove: { move: 'skip' } });
  const two = adv(nb2.state, { type: 'witch_move', seat: witchB, move: 'poison', target: seatsOf(roomB.state, 'villager')[2] });
  assert.equal(two.error, '当前不是女巫用药阶段');
});

test('预言家：验人结果记入私有历史（isWolf 两态）；禁验自己与死者', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const seer = seatOf(s0, 'seer');
  const wolf = seatsOf(s0, 'werewolf')[0];
  const v0 = seatsOf(s0, 'villager')[0];
  const r1 = wolfVoteAll(s0, v0);
  const r2 = adv(r1.state, { type: 'seer_check', seat: seer, target: wolf });
  assert.equal(r2.error, null);
  assert.deepEqual(r2.state.seerChecks, [{ night: 1, target: wolf, isWolf: true }]);
  assert.equal(r2.state.subPhase, 'witch');
  const roomB = newRoom(['张三', '李四', '王五'], 43);
  const rb = wolfVoteAll(roomB.state, seatsOf(roomB.state, 'villager')[0]);
  const rb2 = adv(rb.state, { type: 'seer_check', seat: seatOf(roomB.state, 'seer'), target: seatsOf(roomB.state, 'villager')[1] });
  assert.deepEqual(rb2.state.seerChecks, [{ night: 1, target: seatsOf(roomB.state, 'villager')[1], isWolf: false }]);
  // 禁验自己
  const rSelf = adv(r1.state, { type: 'seer_check', seat: seer, target: seer });
  assert.equal(rSelf.error, '预言家不能验自己');
  assert.equal(rSelf.state, r1.state);
  // 禁验死者（白盒：模拟已死目标）
  const sDead = structuredClone(r1.state);
  sDead.players[wolf - 1].alive = false;
  assert.equal(adv(sDead, { type: 'seer_check', seat: seer, target: wolf }).error, '验人目标必须是存活玩家');
  // 每晚只验一次：重复提交被拒（DO 层幂等忽略）
  assert.equal(adv(r2.state, { type: 'seer_check', seat: seer, target: wolf }).error, '当前不是预言家验人阶段');
});

/* ---------------- 守卫（§1.3 / ADR-0013） ---------------- */

test('守卫：守护免刀（守护且未救 → 活）；奶穿（守护且救 → 死，cause=blade）', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const v0 = seatsOf(room.state, 'villager')[0];
  const guarded = playNight(room.state, { blade: v0, guardTarget: v0, witchMove: { move: 'skip' } });
  const ann = guarded.events.find((e) => e.type === 'day_announce');
  assert.deepEqual(ann.dead, [], '守护且未救 → 刀口存活（平安夜）');
  assert.equal(ann.peaceful, true);
  assert.ok(at(guarded.state, v0).alive);
  assert.equal(guarded.state.guard.last, v0, '守护座位落账持久态');
  const roomB = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const v0b = seatsOf(roomB.state, 'villager')[0];
  const milk = playNight(roomB.state, { blade: v0b, guardTarget: v0b, witchMove: { move: 'save' } });
  assert.deepEqual(milk.events.find((e) => e.type === 'day_announce').dead, [v0b], '同守同救 → 奶穿死');
  assert.equal(at(milk.state, v0b).alive, false);
  assert.equal(at(milk.state, v0b).death.cause, 'blade', '奶穿死因记 blade');
});

test('守卫：毒穿守护（毒目标恒死）；守卫可守自己', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const v0 = seatsOf(room.state, 'villager')[0];
  const v1 = seatsOf(room.state, 'villager')[1];
  // 守 v0、毒 v0、刀 v1 → 双死（毒无视守护）
  const r = playNight(room.state, { blade: v1, guardTarget: v0, witchMove: { move: 'poison', target: v0 } });
  assert.deepEqual(
    r.events.find((e) => e.type === 'day_announce').dead,
    [v0, v1].sort((x, y) => x - y),
    '毒穿守护恒死，与刀口各杀一人'
  );
  assert.equal(at(r.state, v0).death.cause, 'poison');
  // 守自己合法：守卫是刀口时自守免刀
  const roomB = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const gb = seatOf(roomB.state, 'guard');
  const self = playNight(roomB.state, { blade: gb, guardTarget: gb, witchMove: { move: 'skip' } });
  assert.deepEqual(self.events.find((e) => e.type === 'day_announce').dead, [], '守卫自守免刀');
  assert.ok(at(self.state, gb).alive);
});

test('守卫：不可与上一晚守护同一人；guardTarget 天亮清空、guard.last 跨夜保留', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const g = seatOf(room.state, 'guard');
  const vs = seatsOf(room.state, 'villager');
  const n1 = playNight(room.state, { blade: vs[0], guardTarget: vs[1], witchMove: { move: 'skip' } });
  assert.equal(n1.state.night, null, '天亮清空当夜瞬时信息（含 guardTarget）');
  assert.equal(n1.state.guard.last, vs[1], '上一晚守护座位持久保留（连守限制依据）');
  // 白天全弃票平安日 → 第二夜
  const day = autoSpeak(n1.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = null;
  const d1 = castVotes(day.state, votes);
  assert.equal(d1.state.phase, 'night');
  // 第二夜：狼定刀 → 守卫阶段；连守被拒、换人合法
  const w1 = wolfVoteAll(d1.state, vs[1]);
  assert.equal(w1.state.subPhase, 'guard', '第二夜守卫阶段（守卫存活）');
  assert.equal(w1.state.night.guardTarget, null, '新夜 guardTarget 重置为空，不残留上夜目标');
  const again = adv(w1.state, { type: 'guard_protect', seat: g, target: vs[1] });
  assert.equal(again.error, '不可与上一晚守护同一人');
  assert.equal(again.state, w1.state, '拒绝时状态原样返回');
  const hunter = seatOf(room.state, 'hunter');
  const okr = adv(w1.state, { type: 'guard_protect', seat: g, target: hunter });
  assert.equal(okr.error, null, '换人守护合法');
  assert.equal(okr.state.night.guardTarget, hunter);
  assert.equal(okr.state.guard.last, hunter);
  // 越权：非守卫不能提交
  assert.equal(adv(w1.state, { type: 'guard_protect', seat: vs[1], target: hunter }).error, '只有守卫可以守护');
});

test('守卫：enterGuard 跳过（守卫已死 → 狼定刀后直进预言家）；pendingSeat night:guard', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const g = seatOf(room.state, 'guard');
  const w = wolfVoteAll(room.state, seatsOf(room.state, 'villager')[0]);
  assert.equal(w.state.subPhase, 'guard', '守卫在场进入守卫阶段');
  assert.equal(game.pendingSeat(w.state), g, '守卫阶段待行动 = 守卫本人');
  // 白盒：守卫死亡 → 跳过守卫直进预言家（与 enterSeer/enterWitch 同款跳过模式）
  const s = structuredClone(room.state);
  s.players[g - 1].alive = false;
  const r = wolfVoteAll(s, seatsOf(room.state, 'villager')[0]);
  assert.equal(r.state.subPhase, 'seer', '守卫已死 → 跳过守卫阶段');
});

test('守卫回退：随机存活且不与上一晚同人（确定性）；池空任选存活', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'guard');
  const g = seatOf(room.state, 'guard');
  const vs = seatsOf(room.state, 'villager');
  // 第一夜守卫回退（last=null → 任意存活）
  const w1 = wolfVoteAll(room.state, vs[0]);
  assert.equal(w1.state.subPhase, 'guard');
  const f1 = game.applyFallback(w1.state, g);
  const f1b = game.applyFallback(w1.state, g);
  assert.equal(f1.error, null, f1.error);
  assert.deepEqual(f1.state, f1b.state, '回退必须是纯函数');
  const t1 = f1.state.night.guardTarget;
  assert.ok(t1 >= 1 && t1 <= 9 && at(f1.state, t1).alive, '回退守护目标必须是存活玩家');
  // 走完第一夜 → 白天全弃票 → 第二夜守卫回退不连守
  let s = adv(f1.state, { type: 'seer_check', seat: seatOf(f1.state, 'seer'), target: vs[1] }).state;
  s = adv(s, { type: 'witch_move', seat: seatOf(s, 'witch'), move: 'skip' }).state;
  s = autoSpeak(s).state;
  const votes = {};
  for (const p of s.players) if (p.alive) votes[p.seat] = null;
  s = castVotes(s, votes).state;
  const w2 = wolfVoteAll(s, seatOf(s, 'seer'));
  assert.equal(w2.state.subPhase, 'guard');
  assert.equal(w2.state.guard.last, t1, '第一晚守护已落账');
  const f2 = game.applyFallback(w2.state, g);
  assert.equal(f2.error, null, f2.error);
  assert.notEqual(f2.state.night.guardTarget, t1, '回退不得连守上一晚目标');
  // 池空白盒（实际对局不可达：守卫独活 = 狼已全灭，入夜前的检查点必先终局）：
  // 回退的「池空任选存活」分支会选守卫自己，但连守硬规则在 handler 层优先拒绝——防御口径如实断言
  const solo = structuredClone(w1.state);
  solo.guard.last = g;
  for (const p of solo.players) if (p.seat !== g) p.alive = false;
  const soloFrozen = structuredClone(solo);
  const fs = game.applyFallback(solo, g);
  assert.equal(fs.error, '不可与上一晚守护同一人', '池空分支选了唯一存活者（=上晚目标），连守硬规则优先拒绝');
  assert.deepEqual(solo, soloFrozen, '回退不改动入参（纯函数）');
});

/* ---------------- 投票与放逐（§4.2.5–§4.2.7 / §5.9） ---------------- */

test('放逐：最高票出局并发表遗言（暗牌）；逐人投票去向公开；遗言后进入下一夜', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const target = seatsOf(s0, 'villager')[0];
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[1]);
  const voters = s1.players.filter((p) => p.alive).map((p) => p.seat);
  assert.equal(voters.length, 9);
  const firstSeat = voters.find((x) => x !== target);
  const rFirst = adv(s1, { type: 'vote', seat: firstSeat, target });
  assert.equal(rFirst.error, null);
  assert.deepEqual(rFirst.events, [{ type: 'vote', day: 1, round: 'main', seat: firstSeat, target }]);
  const rDup = adv(rFirst.state, { type: 'vote', seat: firstSeat, target });
  assert.equal(rDup.error, '该座位已投过票');
  assert.equal(rDup.state, rFirst.state);
  const rest = {};
  for (const seat of voters) {
    if (seat === firstSeat) continue;
    rest[seat] = seat === target ? null : target; // 目标本人弃票，其余 8 票
  }
  const v = castVotes(rFirst.state, rest);
  const res = v.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, target);
  assert.ok(res.tally.some((t) => t.seat === target && t.count === 8));
  assert.ok(!('role' in res), '放逐结果不翻牌（暗牌）');
  assert.equal(v.state.subPhase, 'exile_lastwords');
  assert.equal(at(v.state, target).alive, false);
  assert.equal(at(v.state, target).death.cause, 'exile');
  const lw = adv(v.state, { type: 'speak', seat: target, text: '我是好人。' });
  assert.deepEqual(lw.events.map((e) => e.type), ['last_words']);
  assert.equal(lw.state.phase, 'night');
  assert.equal(lw.state.day, 2);
  assert.equal(
    rFirst.events.filter((e) => e.type === 'vote').length + v.events.filter((e) => e.type === 'vote').length,
    9,
    '逐人投票去向全部公开（含单独投的第一票）'
  );
});

test('平票：平票者进入 PK 发言与 PK 投票，决出后放逐（§4.2.6）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const vs = seatsOf(s0, 'villager');
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[0]);
  // 构造 4:4 平票（v1 v2 各 4 票），1 人弃票
  const votes = {};
  let given = 0;
  for (const seat of s1.players.filter((p) => p.alive).map((p) => p.seat)) {
    if (seat === vs[0]) votes[seat] = vs[1];
    else if (seat === vs[1]) votes[seat] = vs[0];
    else if (given < 3) { votes[seat] = vs[0]; given += 1; }
    else if (given < 6) { votes[seat] = vs[1]; given += 1; }
    else votes[seat] = null;
  }
  const v = castVotes(s1, votes);
  const res = v.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, null);
  assert.deepEqual(res.pk, [vs[0], vs[1]].sort((x, y) => x - y));
  assert.equal(v.state.subPhase, 'pk_speak');
  assert.deepEqual(v.state.queue, res.pk, '平票者按座位序各发 1 条');
  assert.deepEqual(v.state.pkCandidates, res.pk);
  const pk1 = adv(v.state, { type: 'speak', seat: vs[0], text: '我真是好人。' });
  assert.deepEqual(pk1.events.map((e) => e.type), ['pk_speech']);
  const pk2 = adv(pk1.state, { type: 'speak', seat: vs[1], text: '他才是狼。' });
  assert.deepEqual(pk2.events.map((e) => e.type), ['pk_speech']);
  assert.equal(pk2.state.subPhase, 'pk_vote');
  // PK 投票只能投台上的人
  const bad = adv(pk2.state, { type: 'vote', seat: vs[2], target: seatsOf(s0, 'werewolf')[0] });
  assert.equal(bad.error, 'PK 投票只能投 PK 台上的玩家');
  // 5:3 决出 vs[0]
  const pkVotes = {};
  let n = 0;
  for (const seat of pk2.state.players.filter((p) => p.alive).map((p) => p.seat)) {
    if (seat === vs[0]) pkVotes[seat] = null;
    else if (n < 5) { pkVotes[seat] = vs[0]; n += 1; }
    else pkVotes[seat] = vs[1];
  }
  const pv = castVotes(pk2.state, pkVotes);
  const pres = pv.events.find((e) => e.type === 'vote_result');
  assert.equal(pres.exiled, vs[0]);
  assert.equal(pres.round, 'pk');
  assert.equal(pv.state.subPhase, 'exile_lastwords');
  const lw = adv(pv.state, { type: 'speak', seat: vs[0], text: '你们投错人了。' });
  assert.equal(lw.state.phase, 'night');
  assert.equal(lw.state.day, 2);
  assert.equal(pv.events.filter((e) => e.type === 'vote' && e.round === 'pk').length, 9, 'PK 轮逐人去向同样公开');
});

test('平票：PK 再平 → 无人出局（平安日），直接进入下一夜', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const vs = seatsOf(s0, 'villager');
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[0]);
  const votes = {};
  let given = 0;
  for (const seat of s1.players.filter((p) => p.alive).map((p) => p.seat)) {
    if (seat === vs[0]) votes[seat] = vs[1];
    else if (seat === vs[1]) votes[seat] = vs[0];
    else if (given < 3) { votes[seat] = vs[0]; given += 1; }
    else if (given < 6) { votes[seat] = vs[1]; given += 1; }
    else votes[seat] = null;
  }
  const v = castVotes(s1, votes);
  assert.equal(v.state.subPhase, 'pk_speak');
  const pk = autoSpeak(v.state); // 两名平票者 PK 发言
  assert.equal(pk.state.subPhase, 'pk_vote');
  // PK 轮 2:2 再平，5 人弃票
  const pkVotes = {};
  let n = 0;
  for (const seat of pk.state.players.filter((p) => p.alive).map((p) => p.seat)) {
    if (seat === vs[0]) pkVotes[seat] = vs[1];
    else if (seat === vs[1]) pkVotes[seat] = vs[0];
    else if (n < 1) { pkVotes[seat] = vs[0]; n += 1; }
    else if (n < 2) { pkVotes[seat] = vs[1]; n += 1; }
    else pkVotes[seat] = null;
  }
  const pv = castVotes(pk.state, pkVotes);
  const res = pv.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, null);
  assert.equal(res.peaceful, true);
  assert.equal(res.reason, 'pk-tie');
  assert.equal(pv.state.phase, 'night', '平安日后进入下一夜');
  assert.equal(pv.state.day, 2);
  assert.ok(pv.state.players.every((p) => p.alive), '无人出局');
});

test('全弃票：等同平票 → 无人出局（平安日），不进入 PK', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[0]);
  const votes = {};
  for (const p of s1.players) if (p.alive) votes[p.seat] = null;
  const v = castVotes(s1, votes);
  const res = v.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, null);
  assert.equal(res.peaceful, true);
  assert.equal(res.reason, 'all-abstain');
  assert.equal(v.state.phase, 'night');
  assert.equal(v.state.day, 2);
  assert.ok(v.state.players.every((p) => p.alive));
});

test('被放逐的猎人：先遗言后翻牌开枪（§4.2.7）；被枪杀者无遗言、不翻牌', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const hunter = seatOf(s0, 'hunter');
  const wolf = seatsOf(s0, 'werewolf')[0];
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[0]);
  const votes = {};
  for (const p of s1.players) if (p.alive) votes[p.seat] = p.seat === hunter ? null : hunter;
  const v = castVotes(s1, votes);
  assert.equal(v.events.find((e) => e.type === 'vote_result').exiled, hunter);
  assert.equal(v.state.subPhase, 'exile_lastwords');
  const lw = adv(v.state, { type: 'speak', seat: hunter, text: '我是猎人，看我带谁走。' });
  assert.deepEqual(lw.events.map((e) => e.type), ['last_words'], '遗言在翻牌之前');
  assert.equal(lw.state.subPhase, 'hunter');
  assert.equal(lw.state.pendingHunter, hunter);
  const shot = adv(lw.state, { type: 'hunter_shoot', seat: hunter, target: wolf });
  assert.deepEqual(shot.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot']);
  assert.equal(at(shot.state, wolf).death.cause, 'shot');
  assert.equal(shot.state.phase, 'night', '未分胜负 → 下一夜');
  assert.equal(shot.state.day, 2);
  assert.ok(shot.events.every((e) => e.type !== 'last_words'), '被枪杀者无遗言');
});

/* ---------------- 狼王（§1.2 / ADR-0013） ---------------- */

test('狼王：被放逐时翻牌开枪（hunter_flip / hunter_shoot 带 role 字段）', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'wolfking');
  const wk = seatOf(room.state, 'wolfking');
  const wolf = seatOf(room.state, 'werewolf');
  const s1 = toDayVote(room.state, seatsOf(room.state, 'villager')[0]);
  const votes = {};
  for (const p of s1.players) if (p.alive) votes[p.seat] = p.seat === wk ? null : wk;
  const v = castVotes(s1, votes);
  assert.equal(v.events.find((e) => e.type === 'vote_result').exiled, wk);
  const lw = adv(v.state, { type: 'speak', seat: wk, text: '我是好人。' });
  assert.equal(lw.state.subPhase, 'hunter', '狼王被放逐 → 翻牌开枪槽位（复用猎人管线）');
  assert.equal(lw.state.pendingHunter, wk);
  const shot = adv(lw.state, { type: 'hunter_shoot', seat: wk, target: wolf });
  assert.equal(shot.error, null);
  assert.deepEqual(shot.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot']);
  assert.equal(shot.events[0].role, 'wolfking', '翻牌事件带 role 字段');
  assert.equal(shot.events[1].role, 'wolfking');
  assert.equal(at(shot.state, wolf).death.cause, 'shot', '被枪杀者无遗言、不翻牌');
  assert.equal(shot.state.phase, 'night', '未分胜负 → 下一夜');
  assert.equal(shot.state.day, 2);
});

test('狼王：夜死 / 毒死不开枪（夜死翻牌判定保持 hunter 精确匹配，不扩 isWolf）', () => {
  const roomA = newRoom(['张三', '李四', '王五'], 42, 'wolfking');
  const wkA = seatOf(roomA.state, 'wolfking');
  const rBlade = playNight(roomA.state, { blade: wkA, witchMove: { move: 'skip' } });
  assert.notEqual(rBlade.state.subPhase, 'night_hunter', '狼王夜死无枪');
  assert.equal(rBlade.state.pendingHunter, null);
  assert.equal(rBlade.state.subPhase, 'lastwords', '按普通夜死走首夜遗言');
  assert.equal(at(rBlade.state, wkA).death.cause, 'blade');
  const roomB = newRoom(['张三', '李四', '王五'], 43, 'wolfking');
  const wkB = seatOf(roomB.state, 'wolfking');
  const rPoison = playNight(roomB.state, {
    blade: seatsOf(roomB.state, 'villager')[0],
    witchMove: { move: 'poison', target: wkB },
  });
  assert.notEqual(rPoison.state.subPhase, 'night_hunter', '狼王毒死无枪');
  assert.equal(rPoison.state.pendingHunter, null);
  assert.equal(at(rPoison.state, wkB).death.cause, 'poison');
});

test('狼王：处处视作狼——密聊 / 定刀 / 待行动探查 / 队长池 / parity / 验人结果', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'wolfking');
  const s0 = room.state;
  const wk = seatOf(s0, 'wolfking');
  const wolves = [...seatsOf(s0, 'werewolf'), wk].sort((x, y) => x - y);
  assert.equal(adv(s0, { type: 'wolf_chat', seat: wk, text: '兄弟们稳住' }).error, null, '狼王可密聊');
  const r = adv(s0, { type: 'wolf_target', seat: wk, target: seatsOf(s0, 'villager')[0] });
  assert.equal(r.error, null, '狼王可投票定刀');
  assert.equal(game.pendingSeat(r.state), Math.min(...wolves.filter((w) => w !== wk)), '未投票狼探查含狼王');
  const done = wolfVoteAll(r.state, seatsOf(s0, 'villager')[1]);
  assert.equal(done.error, null);
  assert.notEqual(done.state.subPhase, 'wolf', '含狼王全票投完立即推进（狼王不投则定刀永结不了）');
  // 队长池：白盒只留狼王存活 → 狼王即狼队长
  const s = structuredClone(s0);
  for (const p of s.players) if (p.role === 'werewolf') p.alive = false;
  assert.equal(game.wolfCaptain(s), wk, '狼王进狼队长池');
  // parity：狼王计入狼侧
  const mk = (roles) => ({ players: roles.map((role, i) => ({ seat: i + 1, role, alive: role !== null })) });
  assert.deepEqual(
    game.checkWinner(mk(['wolfking', 'villager', null, null, null, null, null, null, null])),
    { winner: 'wolf', reason: 'parity' },
    '狼王计入狼侧'
  );
  assert.equal(game.checkWinner(mk(['wolfking', 'villager', 'villager', null, null, null, null, null, null])), null);
  // 验人结果：验狼王 = 狼
  const roomC = newRoom(['张三', '李四', '王五'], 42, 'wolfking');
  const wkc = seatOf(roomC.state, 'wolfking');
  const r1 = wolfVoteAll(roomC.state, seatsOf(roomC.state, 'villager')[0]);
  const r2 = adv(r1.state, { type: 'seer_check', seat: seatOf(roomC.state, 'seer'), target: wkc });
  assert.deepEqual(r2.state.seerChecks, [{ night: 1, target: wkc, isWolf: true }], '验狼王 = 狼');
});

test('狼王遗言回退：与狼人同款伪装口径（§1.2 处处视作狼）', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'wolfking');
  const wk = seatOf(room.state, 'wolfking');
  const nv = playNight(room.state, { blade: wk, witchMove: { move: 'skip' } });
  assert.equal(nv.state.subPhase, 'lastwords');
  const f = game.applyFallback(nv.state, nv.state.queue[0]);
  assert.equal(f.error, null, f.error);
  assert.ok(f.events[0].text.includes('我是平民'), `狼王遗言走狼人伪装口径：${f.events[0].text}`);
});

/* ---------------- 白痴（§1.4 / ADR-0013） ---------------- */

test('白痴：被放逐翻牌免死（vote_result.idiot），跳遗言跳翻牌直接放逐检查点；tally 不排除他为候选', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'idiot');
  const id = seatOf(room.state, 'idiot');
  const s1 = toDayVote(room.state, seatsOf(room.state, 'villager')[0]);
  const votes = {};
  for (const p of s1.players) if (p.alive) votes[p.seat] = p.seat === id ? null : id;
  const v = castVotes(s1, votes);
  const res = v.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, id);
  assert.equal(res.idiot, true, '白痴免死标记（§1.5 新可选字段）');
  assert.ok(res.tally.some((t) => t.seat === id && t.count === 8), '白痴可被投票（8 票顶票——但免死，废票）');
  assert.equal(at(v.state, id).alive, true, '翻牌白痴不死');
  assert.equal(at(v.state, id).death, undefined, '不入死名单');
  assert.equal(at(v.state, id).idiotRevealed, true, '翻牌标记落账');
  assert.equal(v.state.phase, 'night', '跳遗言跳翻牌 → 直接入夜');
  assert.equal(v.state.day, 2);
  assert.ok(v.events.every((e) => e.type !== 'last_words'), '无遗言');
  assert.ok(v.events.every((e) => e.type !== 'hunter_flip'), '无翻牌枪');
});

test('白痴：二次被放逐同口径免疫；失去投票权但保留发言权', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'idiot');
  const id = seatOf(room.state, 'idiot');
  const wolf0 = seatsOf(room.state, 'werewolf')[0];
  // 第一天：放逐白痴（翻牌免死）→ 夜 2
  let s = toDayVote(room.state, seatsOf(room.state, 'villager')[0]);
  let votes = {};
  for (const p of s.players) if (p.alive) votes[p.seat] = p.seat === id ? null : id;
  s = castVotes(s, votes).state;
  assert.equal(at(s, id).idiotRevealed, true);
  // 夜 2：刀一名村民 + 毒一狼（解药已用）→ 白天 2
  s = playNight(s, {
    blade: seatsOf(room.state, 'villager')[1],
    witchMove: { move: 'poison', target: wolf0 },
  }).state;
  assert.equal(s.subPhase, 'speak', 'day≥2 无竞选直接发言');
  assert.ok(s.queue.includes(id), '翻牌白痴保留发言权（发言队列照常含他）');
  s = autoSpeak(s).state;
  assert.equal(s.subPhase, 'vote');
  assert.ok(!game.votersOf(s).includes(id), 'votersOf 排除翻牌白痴（待投名单不含他）');
  assert.notEqual(game.pendingSeat(s), id, '待投座位不轮到白痴');
  assert.equal(adv(s, { type: 'vote', seat: id, target: wolf0 }).error, '翻牌白痴无投票权');
  // 其余人全弃票 → 平安日 → 夜 3 → 第三天再放逐白痴：同口径免疫
  votes = {};
  for (const seat of game.votersOf(s)) votes[seat] = null; // 翻牌白痴不在待投名单
  s = castVotes(s, votes).state;
  s = playNight(s, { blade: seatsOf(room.state, 'werewolf')[1], witchMove: { move: 'skip' } }).state;
  s = autoSpeak(s).state;
  votes = {};
  for (const p of s.players) if (p.alive && p.seat !== id) votes[p.seat] = id;
  const v3 = castVotes(s, votes);
  const res3 = v3.events.find((e) => e.type === 'vote_result');
  assert.equal(res3.exiled, id);
  assert.equal(res3.idiot, true, '已翻牌白痴再被放逐同口径免疫');
  assert.equal(at(v3.state, id).alive, true);
  assert.equal(v3.state.phase, 'night', '平安日式推进入夜');
  assert.equal(v3.state.day, 4);
});

test('白痴：夜间被刀正常死亡（无特判）；parity 计入好人侧', () => {
  const room = newRoom(['张三', '李四', '王五'], 42, 'idiot');
  const id = seatOf(room.state, 'idiot');
  const r = playNight(room.state, { blade: id, witchMove: { move: 'skip' } });
  assert.equal(at(r.state, id).alive, false, '夜间刀口白痴正常死亡');
  assert.equal(at(r.state, id).death.cause, 'blade');
  assert.ok(r.events.find((e) => e.type === 'day_announce').dead.includes(id));
  assert.equal(r.state.subPhase, 'lastwords', '首夜死者照常有遗言（白痴无特判）');
  // parity：白痴计入好人侧（1 狼 vs 白痴+民 → 未分；1 狼 vs 白痴 → 平票狼胜）
  const mk = (roles) => ({ players: roles.map((role, i) => ({ seat: i + 1, role, alive: role !== null })) });
  assert.equal(game.checkWinner(mk(['werewolf', 'idiot', 'villager', null, null, null, null, null, null])), null);
  assert.deepEqual(
    game.checkWinner(mk(['werewolf', 'idiot', null, null, null, null, null, null, null])),
    { winner: 'wolf', reason: 'parity' },
    '白痴计入非狼侧'
  );
});

/* ---------------- 胜负判定（§5.7 / §4.3） ---------------- */

test('胜负判定（屠城制）：狼全灭好人胜；狼数 ≥ 非狼即狼胜；否则未分', () => {
  const mk = (roles) => ({ players: roles.map((role, i) => ({ seat: i + 1, role, alive: role !== null })) });
  assert.deepEqual(
    game.checkWinner(mk([null, null, null, 'villager', 'villager', 'seer', null, null, null])),
    { winner: 'good', reason: 'wolves-eliminated' }
  );
  assert.deepEqual(
    game.checkWinner(mk(['werewolf', 'werewolf', null, null, 'villager', null, null, null, null])),
    { winner: 'wolf', reason: 'parity' }
  );
  assert.equal(game.checkWinner(mk(['werewolf', 'werewolf', 'werewolf', 'villager', 'villager', 'villager', 'seer', 'witch', 'hunter'])), null);
  assert.equal(game.checkWinner(mk(['werewolf', 'villager', 'villager', 'villager', 'villager', null, null, null, null])), null);
});

test('整局推进：毒刀夜 → 放逐 → 平安夜 → 放逐最后的狼 → 好人胜；全程公开事件零身份泄漏', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const wolves = seatsOf(s0, 'werewolf');
  const villagers = seatsOf(s0, 'villager');
  const log = [...room.events];
  const step = (r) => {
    assert.equal(r.error, null, r.error);
    log.push(...r.events);
    return r.state;
  };
  // N1：刀 v1 + 毒 w1 → 天亮双死
  let r = playNight(s0, { blade: villagers[0], witchMove: { move: 'poison', target: wolves[0] } });
  let s = step(r);
  assert.deepEqual(r.events.find((e) => e.type === 'day_announce').dead, [villagers[0], wolves[0]].sort((x, y) => x - y));
  // D1：遗言 + 发言 + 6 票放逐 w2
  let day = autoSpeak(s);
  log.push(...day.events);
  s = day.state;
  assert.equal(s.subPhase, 'vote');
  const votes1 = {};
  for (const p of s.players) if (p.alive) votes1[p.seat] = p.seat === wolves[1] ? null : wolves[1];
  const v1 = castVotes(s, votes1);
  log.push(...v1.events);
  assert.equal(v1.state.subPhase, 'exile_lastwords');
  const lw1 = autoSpeak(v1.state); // 被放逐者遗言 → 下一夜
  log.push(...lw1.events);
  s = lw1.state;
  assert.equal(s.phase, 'night');
  assert.equal(s.day, 2);
  // N2：刀 v2 + 女巫救 → 平安夜
  r = playNight(s, { blade: villagers[1], witchMove: { move: 'save' } });
  s = step(r);
  assert.equal(r.events.find((e) => e.type === 'day_announce').peaceful, true);
  // D2：5 票放逐最后的狼 w3
  day = autoSpeak(s);
  log.push(...day.events);
  s = day.state;
  const votes2 = {};
  for (const p of s.players) if (p.alive) votes2[p.seat] = p.seat === wolves[2] ? null : wolves[2];
  const v2 = castVotes(s, votes2);
  log.push(...v2.events);
  s = v2.state;
  assert.equal(s.subPhase, 'exile_lastwords');
  // 最后的狼遗言后立即终局：先 last_words 后 game_over（§4.2.6 → §4.2.8）
  const fin = adv(s, { type: 'speak', seat: wolves[2], text: '好吧，是我。' });
  assert.equal(fin.error, null);
  log.push(...fin.events);
  assert.deepEqual(fin.events.map((e) => e.type), ['last_words', 'game_over']);
  assert.equal(fin.state.phase, 'revealed');
  assert.equal(fin.state.winner, 'good');
  assert.equal(fin.state.reason, 'wolves-eliminated');
  assert.ok(fin.state.players.filter((p) => p.role === 'werewolf').every((p) => !p.alive));
  // 终局后拒绝一切动作（只读复盘）
  assert.ok(adv(fin.state, { type: 'speak', seat: 1, text: 'x' }).error);
  // 全程公开事件零身份泄漏：无 role 字段、无角色词（昵称只有张三/李四/王五/AI-n）；
  // 裁定 2：断言收窄——仅翻牌类事件（hunter_flip / hunter_shoot）允许 role ∈ {hunter, wolfking}
  const json = JSON.stringify(log);
  for (const word of ['werewolf', 'villager', 'seer', 'witch', 'hunter']) {
    assert.ok(!json.includes(word), `公开事件泄漏了身份词：${word}`);
  }
  assert.ok(log.every((e) => {
    if (e.type === 'hunter_flip' || e.type === 'hunter_shoot') {
      return e.role === undefined || e.role === 'hunter' || e.role === 'wolfking';
    }
    return !('role' in e);
  }));
});

test('夜亡猎人开枪先于天亮判胜负：1狼1好的天亮局，猎人翻枪带走狼 → 好人胜（§4.2.2）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolf = seatsOf(s0, 'werewolf')[0];
  const hunter = seatOf(s0, 'hunter');
  const other = seatsOf(s0, 'villager')[0];
  // 白盒：只留 1 狼 + 猎人 + 1 好人。狼刀猎人 → 天亮后 1:1 已达平票，
  // 若「夜结算立即判」先于猎人枪则直接狼胜；规格 §4.2.2 要求翻牌开枪先执行。
  const s = structuredClone(s0);
  const keep = new Set([wolf, hunter, other]);
  for (const p of s.players) if (!keep.has(p.seat)) p.alive = false;
  const r = playNight(s, { blade: hunter });
  assert.equal(r.state.subPhase, 'night_hunter', '开枪槽位先于胜负判定');
  const shot = adv(r.state, { type: 'hunter_shoot', seat: hunter, target: wolf });
  assert.equal(shot.error, null);
  assert.deepEqual(shot.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot', 'game_over']);
  assert.equal(shot.state.phase, 'revealed');
  assert.equal(shot.state.winner, 'good');
  assert.equal(shot.state.reason, 'wolves-eliminated');
});

test('被放逐的猎人放弃开枪：翻牌公告后仍走放逐检查点，进入下一夜', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const hunter = seatOf(s0, 'hunter');
  const s1 = toDayVote(s0, seatsOf(s0, 'villager')[0]);
  const votes = {};
  for (const p of s1.players) if (p.alive) votes[p.seat] = p.seat === hunter ? null : hunter;
  const v = castVotes(s1, votes);
  const lw = adv(v.state, { type: 'speak', seat: hunter, text: '我不开枪。' });
  assert.equal(lw.state.subPhase, 'hunter');
  const skip = adv(lw.state, { type: 'hunter_shoot', seat: hunter, target: null });
  assert.deepEqual(skip.events.map((e) => e.type), ['hunter_flip', 'hunter_skip']);
  assert.equal(skip.state.phase, 'night', '未分胜负 → 放逐检查点通过 → 下一夜');
  assert.equal(skip.state.day, 2);
});

test('夜结算检查点：死亡使狼达成平票 → 天亮公告后立即狼胜，剩余阶段不再执行（§4.3）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const victim = seatsOf(s0, 'villager')[0];
  // 白盒直达终局前夜：只留 2 狼 + 1 民 + 1 猎人（真实对局在到达该存活比前就会终局，
  // 这里只为触达「夜结算 → 立即判胜负」分支；预言家与女巫已死 → 子阶段自动跳过）
  const s = structuredClone(s0);
  const keep = new Set([wolves[0], wolves[1], victim, seatOf(s0, 'hunter')]);
  for (const p of s.players) if (!keep.has(p.seat)) p.alive = false;
  const r = playNight(s, { blade: victim });
  assert.deepEqual(r.events.map((e) => e.type), ['day_announce', 'game_over']);
  assert.equal(r.state.phase, 'revealed');
  assert.equal(r.state.winner, 'wolf');
  assert.equal(r.state.reason, 'parity');
  assert.equal(r.state.subPhase, null);
  assert.ok(r.events.every((e) => e.type !== 'last_words'), '剩余阶段（遗言/发言/投票）不再执行');
});

/* ---------------- 警长（§2 / ADR-0014） ---------------- */

/** day 1 竞选报名驱动：runMap = 座位→是否上警（缺省 false）；返回含 elect_run 事件。 */
function electRun(s, runMap = {}) {
  const events = [];
  for (const p of s.players) {
    if (!p || !p.alive) continue;
    if (s.sheriff.election.run[p.seat] !== undefined) continue;
    const r = adv(s, { type: 'elect_run', seat: p.seat, run: runMap[p.seat] === true });
    assert.equal(r.error, null, `elect_run @${p.seat} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** 竞选发言驱动：按队列序每人一句（campaign / pk_speak 走完为止）。 */
function electSpeak(s, texts) {
  const events = [];
  let i = 0;
  while (s.subPhase === 'elect_campaign' || s.subPhase === 'elect_pk_speak') {
    const seat = game.pendingSeat(s);
    assert.notEqual(seat, null, '竞选发言阶段必须有队列头');
    const r = adv(s, { type: 'elect_speak', seat, text: (texts && texts[i]) || `我是 ${seat} 号，请大家支持。` });
    assert.equal(r.error, null, `elect_speak @${seat} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
    i += 1;
    assert.ok(i < 20, 'electSpeak 必须终止');
  }
  return { state: s, events };
}

/** 退水表态驱动：quitMap = 座位→是否退水（缺省 false 留台）。 */
function electWithdraw(s, quitMap = {}) {
  const events = [];
  for (const seat of s.sheriff.election.candidates.slice()) {
    const r = adv(s, { type: 'elect_withdraw', seat, quit: quitMap[seat] === true });
    assert.equal(r.error, null, `elect_withdraw @${seat} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

/** 警长竞选投票驱动：voteMap = 投票人座位→目标（缺省弃票 null）。 */
function electVotes(s, voteMap = {}) {
  const events = [];
  const voters = game.votersOf(s).filter((x) => !s.sheriff.election.candidates.includes(x));
  for (const seat of voters) {
    const r = adv(s, { type: 'elect_vote', seat, target: voteMap[seat] ?? null });
    assert.equal(r.error, null, `elect_vote @${seat} 不应失败：${r.error}`);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

test('警长竞选全流程：报名 → 竞选发言 → 退水 → 非候选人投票 → 当选（day 1 唯一一次）', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const seer = seatOf(s0, 'seer');
  const v0 = seatsOf(s0, 'villager')[0];
  const first = Math.min(seer, v0);
  const second = Math.max(seer, v0);
  // 平安夜 → day 1 无遗言 → 上警表态（§2.2 时序：遗言之后、发言之前）
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[2], witchMove: { move: 'save' } });
  assert.equal(peace.state.subPhase, 'elect_join');
  const run = electRun(peace.state, { [seer]: true, [v0]: true });
  assert.equal(run.events.filter((e) => e.type === 'elect_run').length, 9, '逐人表态公开');
  assert.equal(run.state.subPhase, 'elect_campaign', '≥2 候选 → 竞选发言');
  assert.deepEqual(run.state.sheriff.election.candidates, [seer, v0].sort((x, y) => x - y));
  assert.deepEqual(run.state.sheriff.election.queue, [seer, v0].sort((x, y) => x - y), '竞选发言按座位序');
  assert.equal(game.pendingSeat(run.state), first, '竞选发言 = 队列头');
  // 严格队列顺序 + 发言上限
  assert.equal(adv(run.state, { type: 'elect_speak', seat: second, text: '抢话' }).error, '还没轮到该座位发言');
  assert.equal(adv(run.state, { type: 'elect_speak', seat: first, text: 'x'.repeat(251) }).error, '发言不得超过 250 字');
  const sp1 = adv(run.state, { type: 'elect_speak', seat: first, text: '我是预言家。' });
  assert.deepEqual(sp1.events, [{ type: 'elect_speech', day: 1, seat: first, text: '我是预言家。' }]);
  const sp2 = adv(sp1.state, { type: 'elect_speak', seat: second, text: '我才是真的。' });
  assert.equal(sp2.state.subPhase, 'elect_withdraw', '竞选发言完毕 → 退水窗口');
  // 都留台 → 警长投票
  const wd = electWithdraw(sp2.state, {});
  assert.equal(wd.events.filter((e) => e.type === 'elect_withdraw').length, 2, '退水表态公开');
  assert.equal(wd.state.subPhase, 'elect_vote');
  const voters = game.votersOf(wd.state).filter((x) => !wd.state.sheriff.election.candidates.includes(x));
  assert.equal(voters.length, 7, '投票人 = 存活非候选人的 7 人');
  assert.equal(game.pendingSeat(wd.state), voters[0], '待投票 = 首个未投的非候选人');
  assert.equal(adv(wd.state, { type: 'elect_vote', seat: seer, target: v0 }).error, '只有存活非候选人可以投警长票', '候选人不投票');
  assert.equal(adv(wd.state, { type: 'elect_vote', seat: voters[0], target: seatsOf(s0, 'werewolf')[0] }).error, '警长投票只能投台上的候选人');
  // 5 票 seer、2 票 v0 → seer 当选
  const voteMap = {};
  voters.forEach((seat, i) => { voteMap[seat] = i < 5 ? seer : v0; });
  const ev = electVotes(wd.state, voteMap);
  assert.equal(ev.events.filter((e) => e.type === 'elect_vote').length, 7, '警长票逐人去向公开');
  const res = ev.events.find((e) => e.type === 'sheriff_result');
  assert.deepEqual(res, { type: 'sheriff_result', day: 1, kind: 'elected', seat: seer });
  assert.equal(ev.state.sheriff.seat, seer);
  assert.equal(ev.state.sheriff.election, null, '竞选态清空');
  assert.equal(ev.state.sheriff.electDone, true, '仅 day 1 竞选一次');
  assert.equal(ev.state.subPhase, 'speak', '竞选出结论 → 白天发言');
});

test('警长竞选分支：0 人上警 none；1 人直接当选；全员上警 no-voters；全退水 none；1 人退水补位当选', () => {
  // 0 候选 → 本局无警长，直接进发言
  {
    const room = newRoom(['张三', '李四', '王五'], 42);
    const peace = playNight(room.state, { blade: seatsOf(room.state, 'villager')[0], witchMove: { move: 'save' } });
    const run = electRun(peace.state, {});
    assert.deepEqual(run.events.find((e) => e.type === 'sheriff_result'), { type: 'sheriff_result', day: 1, kind: 'none' });
    assert.equal(run.state.sheriff.seat, null);
    assert.equal(run.state.subPhase, 'speak');
  }
  // 1 候选 → 直接当选（无竞选发言 / 退水 / 投票）
  {
    const room = newRoom(['张三', '李四', '王五'], 43);
    const seer = seatOf(room.state, 'seer');
    const peace = playNight(room.state, { blade: seatsOf(room.state, 'villager')[0], witchMove: { move: 'save' } });
    const run = electRun(peace.state, { [seer]: true });
    assert.deepEqual(run.events.find((e) => e.type === 'sheriff_result'), { type: 'sheriff_result', day: 1, kind: 'elected', seat: seer });
    assert.equal(run.state.sheriff.seat, seer);
    assert.equal(run.state.subPhase, 'speak');
    assert.ok(run.events.every((e) => e.type !== 'elect_speech' && e.type !== 'elect_withdraw' && e.type !== 'elect_vote'));
  }
  // 全员上警（存活者全是候选人）→ 无投票人 → 本局无警长
  {
    const room = newRoom(['张三', '李四', '王五'], 44);
    const peace = playNight(room.state, { blade: seatsOf(room.state, 'villager')[0], witchMove: { move: 'save' } });
    const all = {};
    for (const p of peace.state.players) if (p.alive) all[p.seat] = true;
    const run = electRun(peace.state, all);
    assert.equal(run.state.subPhase, 'elect_campaign', '9 人全员上警 → 竞选发言');
    const sp = electSpeak(run.state);
    assert.equal(sp.events.filter((e) => e.type === 'elect_speech').length, 9);
    assert.equal(sp.state.subPhase, 'elect_withdraw');
    const wd = electWithdraw(sp.state, {}); // 全员留台 → 无投票人
    assert.deepEqual(wd.events.find((e) => e.type === 'sheriff_result'), { type: 'sheriff_result', day: 1, kind: 'no-voters' });
    assert.equal(wd.state.sheriff.seat, null);
    assert.equal(wd.state.subPhase, 'speak');
  }
  // 2 候选全退水 → none；1 人退水 → 剩 1 人当选
  {
    const room = newRoom(['张三', '李四', '王五'], 45);
    const v0 = seatsOf(room.state, 'villager')[0];
    const v1 = seatsOf(room.state, 'villager')[1];
    const peace = playNight(room.state, { blade: seatsOf(room.state, 'villager')[2], witchMove: { move: 'save' } });
    const run = electRun(peace.state, { [v0]: true, [v1]: true });
    const sp = electSpeak(run.state);
    const wdAll = electWithdraw(sp.state, { [v0]: true, [v1]: true });
    assert.equal(wdAll.events.find((e) => e.type === 'sheriff_result').kind, 'none', '全退水 → 本局无警长');
    assert.equal(wdAll.state.subPhase, 'speak');
    const wdOne = electWithdraw(sp.state, { [v0]: true });
    assert.deepEqual(wdOne.events.find((e) => e.type === 'sheriff_result'), { type: 'sheriff_result', day: 1, kind: 'elected', seat: v1 }, '1 人退水 → 剩 1 人直接当选');
  }
});

test('警长竞选：平票 → PK 发言再投（tie-pk 带 PK 名单）；再平 → 本局无警长', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const vs = seatsOf(room.state, 'villager');
  const v0 = vs[0];
  const v1 = vs[1];
  const peace = playNight(room.state, { blade: vs[2], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [v0]: true, [v1]: true });
  const sp = electSpeak(run.state);
  const wd = electWithdraw(sp.state, {});
  assert.equal(wd.state.subPhase, 'elect_vote');
  // 7 投票人 3:3 + 1 弃 → 平票 PK
  const voters = game.votersOf(wd.state).filter((x) => !wd.state.sheriff.election.candidates.includes(x));
  const tieMap = {};
  voters.forEach((seat, i) => { tieMap[seat] = i < 3 ? v0 : i < 6 ? v1 : null; });
  const ev1 = electVotes(wd.state, tieMap);
  const res1 = ev1.events.find((e) => e.type === 'sheriff_result');
  assert.equal(res1.kind, 'tie-pk', '平票 → PK（裁定 11）');
  assert.deepEqual(res1.pk, [v0, v1].sort((x, y) => x - y), 'PK 台名单随事件透出');
  assert.equal(ev1.state.subPhase, 'elect_pk_speak');
  assert.deepEqual(ev1.state.sheriff.election.pkCandidates, res1.pk);
  // PK 发言 → PK 重投（投票人不变）
  const pk = electSpeak(ev1.state);
  assert.equal(pk.events.filter((e) => e.type === 'elect_speech').length, 2, '平票者各 1 条 PK 发言');
  assert.equal(pk.state.subPhase, 'elect_pk_vote');
  assert.deepEqual(
    game.votersOf(pk.state).filter((x) => !pk.state.sheriff.election.candidates.includes(x)),
    voters,
    'PK 轮投票人不变'
  );
  assert.equal(
    adv(pk.state, { type: 'elect_vote', seat: voters[0], target: seatsOf(room.state, 'werewolf')[0] }).error,
    '警长投票只能投台上的候选人',
    'PK 轮只能投 PK 台上的人'
  );
  // 再平（3:3 + 1 弃）→ 本局无警长
  const ev2 = electVotes(pk.state, tieMap);
  assert.equal(ev2.events.find((e) => e.type === 'sheriff_result').kind, 'none', 'PK 再平 → 本局无警长');
  assert.equal(ev2.state.sheriff.seat, null);
  assert.equal(ev2.state.subPhase, 'speak');
});

test('警长竞选：3 候选平票 → 落选候选出局但不死不再参投；PK 决出当选', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const vs = seatsOf(room.state, 'villager');
  const peace = playNight(room.state, { blade: seatsOf(room.state, 'werewolf')[2], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [vs[0]]: true, [vs[1]]: true, [seatOf(room.state, 'seer')]: true });
  const sp = electSpeak(run.state);
  const wd = electWithdraw(sp.state, {});
  const candidates = wd.state.sheriff.election.candidates;
  const voters = game.votersOf(wd.state).filter((x) => !candidates.includes(x));
  assert.equal(voters.length, 6, '9 - 3 候选 = 6 投票人');
  // 3:3:0 → vs[0] vs[1] 平票上台，预言家落选（出局不死亡）
  const tieMap = {};
  voters.forEach((seat, i) => { tieMap[seat] = i < 3 ? vs[0] : vs[1]; });
  const ev1 = electVotes(wd.state, tieMap);
  const res1 = ev1.events.find((e) => e.type === 'sheriff_result');
  assert.equal(res1.kind, 'tie-pk');
  assert.deepEqual(res1.pk, [vs[0], vs[1]]);
  assert.ok(!ev1.state.sheriff.election.pkCandidates.includes(seatOf(room.state, 'seer')), '落选候选不上 PK 台');
  assert.ok(at(ev1.state, seatOf(room.state, 'seer')).alive, '落选候选出局但不死');
  // PK 决出 vs[0]（4:2）
  const pk = electSpeak(ev1.state);
  const pkMap = {};
  voters.forEach((seat, i) => { pkMap[seat] = i < 4 ? vs[0] : vs[1]; });
  const ev2 = electVotes(pk.state, pkMap);
  assert.equal(ev2.events.find((e) => e.type === 'sheriff_result').kind, 'elected');
  assert.equal(ev2.state.sheriff.seat, vs[0]);
  assert.equal(ev2.state.subPhase, 'speak');
});

test('警长竞选：主轮全弃票 → 本局无警长', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const vs = seatsOf(room.state, 'villager');
  const peace = playNight(room.state, { blade: seatsOf(room.state, 'werewolf')[2], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [vs[0]]: true, [vs[1]]: true });
  const sp = electSpeak(run.state);
  const wd = electWithdraw(sp.state, {});
  const ev = electVotes(wd.state, {}); // 全员弃票
  assert.equal(ev.events.find((e) => e.type === 'sheriff_result').kind, 'none', '主轮全弃 → 本局无警长');
  assert.equal(ev.state.sheriff.seat, null);
  assert.equal(ev.state.subPhase, 'speak');
});

test('警长 1.5 票：主投票计票权重 1.5（tally 带 2.5）；4:4 中警长侧不进 PK 直接放逐；狼队定刀不加权', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const seer = seatOf(s0, 'seer');
  const v0 = seatsOf(s0, 'villager')[0];
  const v1 = seatsOf(s0, 'villager')[1];
  // day 1：seer 唯一候选直接当选警长
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[2], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [seer]: true });
  assert.equal(run.state.sheriff.seat, seer);
  const day = autoSpeak(run.state);
  assert.equal(day.state.subPhase, 'vote');
  // 警长投 v0（1.5）+ 1 人投 v0（1）= 2.5；2 人投 v1 = 2；其余弃票 → v0 2.5 顶票放逐
  const votes = {};
  const others = day.state.players.filter((p) => p.alive && p.seat !== seer).map((p) => p.seat);
  votes[seer] = v0;
  votes[others[0]] = v0;
  votes[others[1]] = v1;
  votes[others[2]] = v1;
  for (const x of others.slice(3)) votes[x] = null;
  const v = castVotes(day.state, votes);
  const res = v.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, v0, '2.5 > 2 → 放逐 v0');
  assert.equal(res.tally.find((t) => t.seat === v0).count, 2.5, '警长票计 1.5');
  assert.equal(res.tally.find((t) => t.seat === v1).count, 2);
  // 4:4 中警长票侧 3+1.5=4.5:4 → 不进 PK 直接放逐（若按 1 票则 3:4 应放逐对方，口径分叉可测）
  const roomB = newRoom(['张三', '李四', '王五'], 43);
  const seerB = seatOf(roomB.state, 'seer');
  const v0b = seatsOf(roomB.state, 'villager')[0];
  const v1b = seatsOf(roomB.state, 'villager')[1];
  const peaceB = playNight(roomB.state, { blade: seatsOf(roomB.state, 'villager')[2], witchMove: { move: 'save' } });
  const runB = electRun(peaceB.state, { [seerB]: true });
  const dayB = autoSpeak(runB.state);
  const votesB = {};
  const othersB = dayB.state.players.filter((p) => p.alive && p.seat !== seerB).map((p) => p.seat);
  votesB[seerB] = v0b; // 警长投 v0b → 3 + 1.5 = 4.5
  votesB[othersB[0]] = v0b;
  votesB[othersB[1]] = v0b;
  votesB[othersB[2]] = v0b;
  for (const x of othersB.slice(3, 7)) votesB[x] = v1b; // v1b = 4
  for (const x of othersB.slice(7)) votesB[x] = null;
  const vB = castVotes(dayB.state, votesB);
  const resB = vB.events.find((e) => e.type === 'vote_result');
  assert.equal(resB.exiled, v0b, '警长 1.5 票打破 4:4（4.5:4，不进 PK）');
  assert.equal(resB.tally.find((t) => t.seat === v0b).count, 4.5);
  // 狼队定刀不加权：白盒把狼设为警长，两狼 1:1 平票由狼队长裁定（若误加权则警长狼 1.5 翻盘）
  const roomW = newRoom(['张三', '李四', '王五'], 42);
  let sw = toDayVote(roomW.state, seatsOf(roomW.state, 'villager')[0]);
  const vw = {};
  for (const p of sw.players) if (p.alive) vw[p.seat] = null;
  sw = castVotes(sw, vw).state; // 平安日 → 夜 2
  assert.equal(sw.phase, 'night');
  sw = structuredClone(sw);
  const wolvesW = seatsOf(roomW.state, 'werewolf');
  const vA = seatsOf(roomW.state, 'villager')[1];
  const vB2 = seatsOf(roomW.state, 'villager')[2];
  const keep = new Set([wolvesW[0], wolvesW[1], vA, vB2]);
  for (const p of sw.players) if (!keep.has(p.seat)) p.alive = false;
  sw.sheriff.seat = wolvesW[0]; // 白盒：一号狼是警长
  sw.players[wolvesW[0] - 1].isAI = true;
  sw.players[wolvesW[1] - 1].isAI = false; // 白盒：二号狼（真人）成为狼队长
  const cap = game.wolfCaptain(sw);
  assert.notEqual(cap, wolvesW[0], '前置：队长不是警长狼（否则区分不了加权）');
  // 警长狼投 vA、队长狼投 vB2 → 1:1 → 队长票裁定 vB2（若定刀误按 1.5 加权则 vA 胜出）
  const wVote1 = adv(sw, { type: 'wolf_target', seat: wolvesW[0], target: vA });
  assert.equal(wVote1.error, null);
  const wVote2 = adv(wVote1.state, { type: 'wolf_target', seat: wolvesW[1], target: vB2 });
  assert.equal(wVote2.error, null);
  assert.ok(wVote2.events.find((e) => e.type === 'day_announce').dead.includes(vB2), '狼队定刀按整票计，队长票裁定刀口');
  assert.ok(!wVote2.events.find((e) => e.type === 'day_announce').dead.includes(vA));
});

test('警徽流：夜死警长 → 闸口①拦截（next=day）→ 移交 / 撕毁；badge 回退 = 撕警徽；day≥2 无竞选', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const seer = seatOf(s0, 'seer');
  const to = seatsOf(s0, 'villager')[1];
  // day 1：seer 当选警长 → 全弃票平安日 → 夜 2 刀警长
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[1], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [seer]: true });
  assert.equal(run.state.sheriff.seat, seer);
  const day = autoSpeak(run.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = null;
  const s = castVotes(day.state, votes).state; // 平安日 → 夜 2
  assert.equal(s.phase, 'night');
  const n2 = playNight(s, { blade: seer, witchMove: { move: 'skip' } });
  // day 2：enterDayFlow 闸口①拦截 → badge
  assert.equal(n2.state.subPhase, 'badge', '夜死警长 → 白天闸口①先处置警徽（裁定 7）');
  assert.deepEqual(n2.state.badge, { pending: seer, next: 'day' });
  assert.equal(game.pendingSeat(n2.state), seer, 'badge 待行动 = 死亡警长本人（同遗言死者模式）');
  // 越权与非法目标
  assert.equal(adv(n2.state, { type: 'badge_move', seat: to, target: 1 }).error, '只有待处置警徽的警长可以移交警徽');
  assert.equal(adv(n2.state, { type: 'badge_move', seat: seer, target: seer }).error, '警徽接收者必须是存活玩家');
  // 移交警徽 → 新警长，恢复白天主链（day≥2 直接发言，无竞选）
  const mv = adv(n2.state, { type: 'badge_move', seat: seer, target: to });
  assert.equal(mv.error, null);
  assert.deepEqual(mv.events, [{ type: 'badge_move', day: 2, from: seer, to }]);
  assert.equal(mv.state.sheriff.seat, to, '移交警徽 → 新警长');
  assert.equal(mv.state.badge, null);
  assert.equal(mv.state.subPhase, 'speak', 'day≥2 恢复直接发言（无竞选）');
  // 撕毁路径 + badge 回退（另一局）
  const roomB = newRoom(['张三', '李四', '王五'], 43);
  const seerB = seatOf(roomB.state, 'seer');
  const peaceB = playNight(roomB.state, { blade: seatsOf(roomB.state, 'villager')[1], witchMove: { move: 'save' } });
  const runB = electRun(peaceB.state, { [seerB]: true });
  const dayB = autoSpeak(runB.state);
  const votesB = {};
  for (const p of dayB.state.players) if (p.alive) votesB[p.seat] = null;
  const nB = playNight(castVotes(dayB.state, votesB).state, { blade: seerB, witchMove: { move: 'skip' } }).state;
  assert.equal(nB.subPhase, 'badge');
  const kill = adv(nB, { type: 'badge_move', seat: seerB, target: null });
  assert.deepEqual(kill.events, [{ type: 'badge_move', day: 2, from: seerB, to: null }]);
  assert.equal(kill.state.sheriff.seat, null, '撕毁 → 本局无警长');
  assert.equal(kill.state.subPhase, 'speak');
  const fC = game.applyFallback(nB, seerB);
  assert.equal(fC.error, null, fC.error);
  assert.equal(fC.state.sheriff.seat, null, 'badge 回退 = 撕警徽（§2.4）');
  assert.equal(fC.state.badge, null);
});

test('警徽流：被放逐警长 → 遗言后、翻牌前（闸口②）；警长=猎人时 badge 后才开枪', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const hunter = seatOf(s0, 'hunter');
  const to = seatsOf(s0, 'villager')[0];
  const wolf = seatsOf(s0, 'werewolf')[0];
  // day 1：猎人唯一候选当选警长 → 白天放逐猎人警长
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[1], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [hunter]: true });
  assert.equal(run.state.sheriff.seat, hunter);
  const day = autoSpeak(run.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = p.seat === hunter ? null : hunter;
  const v = castVotes(day.state, votes);
  assert.equal(v.events.find((e) => e.type === 'vote_result').exiled, hunter);
  assert.equal(v.state.subPhase, 'exile_lastwords');
  const lw = adv(v.state, { type: 'speak', seat: hunter, text: '我是猎人警长。' });
  assert.deepEqual(lw.events.map((e) => e.type), ['last_words'], '遗言在警徽处置之前');
  assert.equal(lw.state.subPhase, 'badge', '遗言后进警徽处置（先于翻牌，裁定 7 闸口②）');
  assert.deepEqual(lw.state.badge, { pending: hunter, next: 'exile' });
  const mv = adv(lw.state, { type: 'badge_move', seat: hunter, target: to });
  assert.deepEqual(mv.events, [{ type: 'badge_move', day: 1, from: hunter, to }]);
  assert.equal(mv.state.subPhase, 'hunter', '警徽处置后重走猎人翻牌判定');
  assert.equal(mv.state.pendingHunter, hunter);
  const shot = adv(mv.state, { type: 'hunter_shoot', seat: hunter, target: wolf });
  assert.deepEqual(shot.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot']);
  assert.ok(!('role' in shot.events[0]), '标准板猎人翻牌不带 role 字段（缺省按 hunter 渲染）');
  assert.equal(shot.state.phase, 'night', '未分胜负 → 下一夜');
  assert.equal(shot.state.day, 2);
  assert.equal(shot.state.sheriff.seat, to, '警徽已移交，翻牌枪不再触发警徽处置');
});

test('警徽流：被枪杀警长 → 闸口③（checkAndNextNight 入口）拦截，处置后入夜', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const hunter = seatOf(s0, 'hunter');
  const sheriff = seatOf(s0, 'seer');
  // day 1：seer 当选警长；白天放逐猎人（非警长）→ 翻牌枪杀警长
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[1], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [sheriff]: true });
  assert.equal(run.state.sheriff.seat, sheriff);
  const day = autoSpeak(run.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = p.seat === hunter ? null : hunter;
  const v = castVotes(day.state, votes);
  const lw = adv(v.state, { type: 'speak', seat: hunter, text: '看我带谁走。' });
  assert.equal(lw.state.subPhase, 'hunter');
  const shot = adv(lw.state, { type: 'hunter_shoot', seat: hunter, target: sheriff });
  assert.deepEqual(shot.events.map((e) => e.type), ['hunter_flip', 'hunter_shoot']);
  assert.equal(shot.state.subPhase, 'badge', '被枪杀警长 → 入夜闸口③先处置警徽');
  assert.deepEqual(shot.state.badge, { pending: sheriff, next: 'night' });
  const mv = adv(shot.state, { type: 'badge_move', seat: sheriff, target: seatsOf(s0, 'villager')[0] });
  assert.equal(mv.error, null);
  assert.deepEqual(mv.events.map((e) => e.type), ['badge_move']);
  assert.equal(mv.state.phase, 'night', '警徽处置完 → 入夜');
  assert.equal(mv.state.day, 2);
});

test('警徽流：警长死亡致终局 → 不处置警徽（gameOver 清 badge 作废）', () => {
  const room = newRoom(['张三', '李四', '王五'], 42);
  const s0 = room.state;
  const seer = seatOf(s0, 'seer');
  const wolf = seatsOf(s0, 'werewolf')[0];
  const vill = seatsOf(s0, 'villager')[0];
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[1], witchMove: { move: 'save' } });
  const run = electRun(peace.state, { [seer]: true });
  const day = autoSpeak(run.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = null;
  let s = castVotes(day.state, votes).state; // 平安日 → 夜 2
  // 白盒：只留 1 狼 + 警长 + 1 村民（1 狼 < 2 好人 → 未终局），夜 2 刀警长 → 1:1 平票狼胜
  s = structuredClone(s);
  const keep = new Set([wolf, seer, vill]);
  for (const p of s.players) if (!keep.has(p.seat)) p.alive = false;
  const r = playNight(s, { blade: seer, witchMove: { move: 'skip' } });
  assert.equal(r.state.phase, 'revealed', '刀警长后 1:1 平票 → 狼胜终局');
  assert.equal(r.state.winner, 'wolf');
  assert.equal(r.state.reason, 'parity');
  assert.equal(r.state.badge, null, '终局不处置警徽（gameOver 清空作废）');
  assert.equal(r.state.subPhase, null);
  assert.ok(r.events.every((e) => e.type !== 'badge_move'));
});

/* ---------------- AI 补位（§7.4 / §7.5） ---------------- */

test('AI 补位：空位按座位序补 AI-1…；最小开桌 3 真人，不足拒绝；9 真人不补；满员拒绝加入', () => {
  const players = new Array(9).fill(null);
  players[0] = { seat: 1, nick: '甲', isAI: false };
  players[2] = { seat: 3, nick: '乙', isAI: false };
  players[8] = { seat: 9, nick: '丙', isAI: false };
  const ais = game.generateAISeats(players);
  assert.deepEqual(ais.map((a) => a.seat), [2, 4, 5, 6, 7, 8]);
  assert.deepEqual(ais.map((a) => a.nick), ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6']);
  assert.ok(ais.every((a) => a.isAI && a.ready && a.alive && a.role === null));

  // 2 真人开桌 → 拒绝（最小开桌 3 人）
  let s = game.createInitialState();
  for (let i = 0; i < 2; i++) s = adv(s, { type: 'join', nick: `p${i}`, uid: `u${i}` }).state;
  for (let seat = 1; seat <= 2; seat++) s = adv(s, { type: 'ready', seat, ready: true }).state;
  const tooFew = adv(s, { type: 'start', seed: 1 });
  assert.equal(tooFew.error, '真人不足 3 人，无法开桌');
  assert.equal(tooFew.state, s);
  // 第 3 人加入但未准备 → start 重校验拒绝（§7.4 提交瞬间重算）
  s = adv(s, { type: 'join', nick: 'p2', uid: 'u2' }).state;
  const notReady = adv(s, { type: 'start', seed: 1 });
  assert.equal(notReady.error, '仍有真人未准备');
  // 9 真人满员：第 10 人加入拒绝；开局无 AI
  let s9 = game.createInitialState();
  for (let i = 0; i < 9; i++) s9 = adv(s9, { type: 'join', nick: `p${i}`, uid: `n${i}` }).state;
  assert.equal(adv(s9, { type: 'join', nick: 'x', uid: 'x' }).error, '房间已满');
  for (let seat = 1; seat <= 9; seat++) s9 = adv(s9, { type: 'ready', seat, ready: true }).state;
  const st = adv(s9, { type: 'start', seed: 7 });
  assert.equal(st.error, null);
  assert.ok(st.state.players.every((p) => !p.isAI));
  assert.equal(game.generateAISeats(st.state.players).length, 0);
  // 3 真人开桌 → 补 6 AI 到 9（发牌测试已验命名，这里验数量）
  const three = newRoom(['张三', '李四', '王五'], 42);
  assert.equal(three.state.players.filter((p) => p.isAI).length, 6);
  assert.equal(three.state.players.filter((p) => !p.isAI).length, 3);
});

/* ---------------- 开局名册（§7.5 / ADR-0009）：AI 网名与人格 ---------------- */

test('开局名册：AI 昵称与人格按补位顺序对位，与发牌身份无关；缺条目回退 AI-n', () => {
  const roster = [
    { nick: '逻辑闭环怪', persona: PERSONAS[0] },
    { nick: '先投为敬' }, // 无 persona：合法，座位不带人格
  ];
  const s0 = game.advance(game.createInitialState(), { type: 'join', nick: '我', uid: 'u1' }).state;
  const s = adv(s0, { type: 'ready', seat: 1, ready: true }).state;
  const r = adv(s, { type: 'start', seed: 42, solo: true, roster });
  assert.equal(r.error, null);
  const ais = r.state.players.filter((p) => p.isAI);
  // 开局座位洗牌后 AI 座位号与补位顺序解耦：按集合断言网名，按网名回查人格成对迁移
  assert.deepEqual(
    ais.map((p) => p.nick).sort(),
    [...roster.map((e) => e.nick), 'AI-3', 'AI-4', 'AI-5', 'AI-6', 'AI-7', 'AI-8'].sort()
  );
  const byNick = (st, nick) => st.players.find((p) => p.nick === nick);
  assert.equal(byNick(r.state, '逻辑闭环怪').persona, PERSONAS[0]);
  assert.equal(byNick(r.state, '先投为敬').persona, undefined);
  assert.ok(ais.filter((p) => /^AI-\d$/.test(p.nick)).every((p) => p.persona === undefined), '回退座位不带人格');
  // 网名与人格只贴人格池、与身份无关：同一 AI 抽什么身份都带同一个网名
  const rolesA = r.state.players.map((p) => p.role);
  const r2 = adv(s, { type: 'start', seed: 43, solo: true, roster }).state;
  assert.equal(byNick(r2, '逻辑闭环怪').persona, PERSONAS[0], '不同 seed 下名册对仍成立');
  assert.notDeepEqual(r2.players.map((p) => p.role), rolesA, '种子不同发牌不同');
  // game_start 公开事件带新网名（不含 role / persona，暗牌口径不变）
  const startEv = r.events.find((e) => e.type === 'game_start');
  assert.ok(startEv.players.some((p) => p.nick === '逻辑闭环怪'));
  assert.ok(startEv.players.every((p) => !('role' in p) && !('persona' in p)));
});

test('开局名册：形状非法严进拒绝开局（不静默降级）；省略 roster 走默认 AI-n（部署过渡）', () => {
  const base = game.advance(game.createInitialState(), { type: 'join', nick: '我', uid: 'u1' }).state;
  const ready = adv(base, { type: 'ready', seat: 1, ready: true }).state;
  const bad = [
    { roster: 'x', why: '非数组' },
    { roster: [{ nick: '' }], why: '空昵称' },
    { roster: [{ nick: '超'.repeat(21) }], why: '昵称超长' },
    { roster: [{ nick: '甲', persona: '' }], why: '空人格' },
    { roster: [{ nick: '甲', persona: '超'.repeat(121) }], why: '人格超长' },
    { roster: [{ nick: '甲' }, 'x'], why: '条目非对象' },
    { roster: new Array(9).fill({ nick: '甲' }), why: '超过 8 条' },
  ];
  for (const { roster, why } of bad) {
    const r = adv(ready, { type: 'start', seed: 42, solo: true, roster });
    assert.notEqual(r.error, null, `非法名册应拒绝开局：${why}`);
    assert.equal(r.state, ready, '拒绝时状态原样返回');
  }
  // 不带 roster → 默认昵称（旧调用方 / 部署过渡兼容），无 persona
  const plain = adv(ready, { type: "start", seed: 42, solo: true });
  assert.equal(plain.error, null);
  assert.deepEqual(
    plain.state.players.filter((p) => p.isAI).map((p) => p.nick).sort(),
    ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6', 'AI-7', 'AI-8']
  );
  assert.ok(plain.state.players.every((p) => p.persona === undefined));
});

/* ---------------- 狼队长（§5.1） ---------------- */

test('狼队长：真人优先，多人取座位号最小；否则座位号最小 AI 狼', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const humanSeats = new Set(s0.players.filter((p) => p && !p.isAI).map((p) => p.seat));
  const humanWolves = wolves.filter((x) => humanSeats.has(x)); // 真人狼（开局座位洗牌后不再固定 1–3）
  const expect = humanWolves.length > 0 ? Math.min(...humanWolves) : Math.min(...wolves);
  assert.equal(game.wolfCaptain(s0), expect);
  // 全部真人狼死后由 AI 狼接任（白盒：标记真人狼死亡）
  const s = structuredClone(s0);
  for (const x of humanWolves) s.players[x - 1].alive = false;
  const aiWolves = wolves.filter((x) => !humanSeats.has(x)).filter((x) => s.players[x - 1].alive);
  if (aiWolves.length > 0) assert.equal(game.wolfCaptain(s), Math.min(...aiWolves));
  else assert.equal(game.wolfCaptain(s), null);
});

/* ---------------- 狼队密聊与投票定刀（§4.1.1） ---------------- */

test('狼队定刀投票：多数决；平票由狼队长裁定（队长票在平票集合中则从其票）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const cap = game.wolfCaptain(s0);
  const v1 = seatsOf(s0, 'villager')[0];
  const v2 = seatsOf(s0, 'villager')[1];
  const seerSeat = seatOf(s0, 'seer');
  const mates = wolves.filter((s) => s !== cap);

  // 多数决：两票 v1、一票 v2 → 刀 v1；未投完时停狼阶段
  let r = adv(s0, { type: 'wolf_target', seat: mates[0], target: v1 });
  assert.equal(r.error, null);
  assert.equal(r.state.subPhase, 'wolf', '还有队友未投票 → 停在狼阶段');
  assert.equal(adv(r.state, { type: 'wolf_target', seat: mates[0], target: v2 }).error, '你已投过票，不可更改', '一狼一票不可改');
  r = adv(r.state, { type: 'wolf_target', seat: cap, target: v1 });
  r = adv(r.state, { type: 'wolf_target', seat: mates[1], target: v2 });
  assert.equal(r.error, null);
  assert.equal(r.state.night.blade, v1, '最高票出局');
  assert.notEqual(r.state.subPhase, 'wolf', '全票投完立即推进');

  // 平票：三狼各投不同目标 → 三方平票 → 队长的票一锤定音
  let t = adv(s0, { type: 'wolf_target', seat: cap, target: v2 });
  t = adv(t.state, { type: 'wolf_target', seat: mates[0], target: v1 });
  t = adv(t.state, { type: 'wolf_target', seat: mates[1], target: seerSeat });
  assert.equal(t.error, null);
  assert.equal(t.state.night.blade, v2, '三方平票 → 队长的票裁定');
});

test('狼队密聊：仅存活狼、限长限次、不产生公开事件（§4.1.1）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const villager = seatsOf(s0, 'villager')[0];
  assert.equal(adv(s0, { type: 'wolf_chat', seat: villager, text: '我是好人' }).error, '只有存活狼人可以参与密聊');
  assert.equal(adv(s0, { type: 'wolf_chat', seat: wolves[0], text: '' }).error, '密聊内容不能为空');
  assert.ok(
    adv(s0, { type: 'wolf_chat', seat: wolves[0], text: 'x'.repeat(61) }).error.includes('60'),
    '每条不超过 60 字'
  );
  let r = adv(s0, { type: 'wolf_chat', seat: wolves[0], text: '刀 4 号，白天我跳预言家' });
  assert.equal(r.error, null);
  assert.deepEqual(r.events, [], '密聊不产生公开事件（§4.1.5）');
  assert.deepEqual(r.state.wolfChatLog, [{ n: 1, seat: wolves[0], text: '刀 4 号，白天我跳预言家' }]);
  let s = r.state;
  for (let i = 0; i < game.WOLF_CHAT_TURNS - 1; i++) {
    s = adv(s, { type: 'wolf_chat', seat: wolves[0], text: `补 ${i}` }).state;
  }
  assert.ok(adv(s, { type: 'wolf_chat', seat: wolves[0], text: '第六条' }).error.includes('5 条'), '每晚每狼限 5 条');
  // 死狼被拒（白盒标记死亡）；天亮结算后 night 瞬时清空、密聊日志跨夜保留（§4.1.1 修订）
  const sDead = structuredClone(s);
  sDead.players[wolves[1] - 1].alive = false;
  assert.equal(adv(sDead, { type: 'wolf_chat', seat: wolves[1], text: '我还想聊' }).error, '只有存活狼人可以参与密聊');
  const dawn = playNight(s, { blade: villager, witchMove: { move: 'skip' } });
  assert.equal(dawn.state.night, null, '天亮当夜瞬时信息清空');
  assert.equal(dawn.state.wolfChatLog.length, game.WOLF_CHAT_TURNS, '密聊日志跨夜保留不清空');
  assert.ok(dawn.state.wolfChatLog.every((m) => m.n === 1), '日志条目带夜号');
});

test('待行动座位：狼阶段 = 第一个未投票的存活狼（AI 驱动与 150s 超时按此逐狼推进）', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const first = Math.min(...wolves);
  assert.equal(game.pendingSeat(s0), first);
  const r = adv(s0, { type: 'wolf_target', seat: first, target: 1 });
  assert.equal(r.error, null);
  assert.equal(game.pendingSeat(r.state), Math.min(...wolves.filter((w) => w !== first)), '下一个未投票的狼');
});

/* ---------------- 行动校验与纯度 ---------------- */

test('行动校验：越权 / 非法目标 / 错误阶段一律拒绝，失败时返回原状态引用且零事件', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const notWolf = s0.players.find((p) => p.alive && p.role !== 'werewolf').seat;
  assert.equal(adv(s0, { type: 'wolf_target', seat: notWolf, target: 1 }).error, '只有存活狼人可以投票定刀');
  const bad = adv(s0, { type: 'wolf_target', seat: notWolf, target: 1 });
  assert.equal(bad.state, s0, '失败必须原样返回入参状态（纯函数）');
  assert.deepEqual(bad.events, []);
  // 刀口必须存活（不可空刀）
  const sDead = structuredClone(s0);
  sDead.players[3].alive = false; // 白盒：座位 4 已死
  const deadWolf = sDead.players.find((p) => p.alive && p.role === 'werewolf').seat;
  assert.equal(adv(sDead, { type: 'wolf_target', seat: deadWolf, target: 4 }).error, '刀口必须是存活玩家（狼不可空刀，§5.10）');
  // 错误阶段（全员投票定刀后才离开狼阶段）
  const sSeer = wolfVoteAll(s0, 1).state;
  assert.equal(adv(sSeer, { type: 'wolf_target', seat: seatsOf(s0, 'werewolf')[0], target: 2 }).error, '当前不是狼人定刀阶段');
  assert.equal(adv(sSeer, { type: 'speak', seat: 1, text: 'x' }).error, '当前不是可发言阶段');
  assert.equal(adv(sSeer, { type: 'vote', seat: 1, target: 2 }).error, '当前不是投票阶段');
  assert.equal(adv(sSeer, { type: 'hunter_shoot', seat: seatOf(s0, 'hunter'), target: 1 }).error, '当前不是猎人开枪阶段');
  // 发言：未轮到 / 超过硬上限 250 字 / 空
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'save' } });
  const el = autoElect(peace.state); // day 1 竞选：回退全员不上警 → 无警长
  assert.equal(el.state.subPhase, 'speak');
  const head = el.state.queue[0];
  const other = el.state.queue[1];
  assert.equal(adv(el.state, { type: 'speak', seat: other, text: '抢话' }).error, '还没轮到该座位发言');
  assert.equal(adv(el.state, { type: 'speak', seat: head, text: 'x'.repeat(251) }).error, '发言不得超过 250 字');
  assert.equal(adv(el.state, { type: 'speak', seat: head, text: '   ' }).error, '发言不能为空');
  const good = adv(el.state, { type: 'speak', seat: head, text: '我是好人。' });
  assert.equal(good.error, null);
  // 死人不能投票
  const atVote = autoSpeak(good.state);
  assert.equal(atVote.state.subPhase, 'vote');
  const vsDead = structuredClone(atVote.state);
  vsDead.players[0].alive = false; // 白盒：座位 1 已死
  assert.equal(adv(vsDead, { type: 'vote', seat: 1, target: 2 }).error, '只有存活玩家可以投票');
  // 猎人枪死目标
  const sHunt = structuredClone(el.state);
  sHunt.phase = 'day';
  sHunt.subPhase = 'hunter';
  sHunt.pendingHunter = seatOf(s0, 'hunter');
  sHunt.players[2].alive = false;
  assert.equal(adv(sHunt, { type: 'hunter_shoot', seat: seatOf(s0, 'hunter'), target: 3 }).error, '枪目标必须是存活玩家');
  // 未知动作 / revealed 只读
  assert.equal(adv(s0, { type: 'dance' }).error, '未知动作类型：dance');
  const sRev = structuredClone(el.state);
  sRev.phase = 'revealed';
  assert.ok(adv(sRev, { type: 'speak', seat: 1, text: 'x' }).error, '终局后应拒绝动作');
});

/* ---------------- 确定性回退（§8.4）与 pendingSeat ---------------- */

test('确定性回退：同状态同结果；狼刀随机存活、女巫跳过、猎人不开枪、发言固定兜底句、投票不投自己', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  // 狼刀回退：未投票的狼被回退 → 随机投一票（同状态必同结果）；全员投完才定刀
  const first = game.pendingSeat(s0);
  const fa = game.applyFallback(s0, first);
  const fb = game.applyFallback(s0, first);
  assert.equal(fa.error, null, fa.error);
  assert.deepEqual(fa.state, fb.state, '回退必须是纯函数');
  assert.ok(fa.state.night.wolfVotes[first] != null, '回退为该狼投出一票');
  const done = wolfVoteAll(fa.state, seatsOf(s0, 'villager')[0]);
  assert.ok(at(s0, done.state.night.blade).alive, '最终刀口必须是存活玩家');
  // 女巫回退 = 跳过 → 直接天亮结算
  const w1 = wolfVoteAll(s0, seatsOf(s0, 'villager')[0]);
  const w2 = adv(w1.state, { type: 'seer_check', seat: seatOf(s0, 'seer'), target: seatsOf(s0, 'villager')[1] });
  assert.equal(w2.state.subPhase, 'witch');
  const fw = game.applyFallback(w2.state, seatOf(s0, 'witch'));
  assert.equal(fw.error, null, fw.error);
  assert.equal(fw.state.phase, 'day');
  assert.equal(fw.events[0].type, 'day_announce');
  // 猎人回退 = 不开枪（先翻牌后放弃）
  const hunter = seatOf(s0, 'hunter');
  const hn = playNight(s0, { blade: hunter, witchMove: { move: 'skip' } });
  assert.equal(hn.state.subPhase, 'night_hunter');
  const fh = game.applyFallback(hn.state, hunter);
  assert.equal(fh.error, null, fh.error);
  assert.deepEqual(fh.events.map((e) => e.type), ['hunter_flip', 'hunter_skip']);
  // 死者的遗言也有回退（首夜死者猎人翻牌放弃后）；遗言链走完 → day 1 竞选
  const skip = adv(hn.state, { type: 'hunter_shoot', seat: hunter, target: null }).state;
  assert.equal(skip.subPhase, 'lastwords');
  const lw = game.applyFallback(skip, skip.queue[0]);
  assert.equal(lw.error, null, lw.error);
  assert.equal(lw.events[0].type, 'last_words');
  assert.equal(lw.state.subPhase, 'elect_join', '遗言走完 → day 1 竞选（§2.2 时序）');
  const el = autoElect(lw.state); // 竞选回退 = 全员不上警 → 无警长
  assert.equal(el.state.subPhase, 'speak');
  // 发言回退 = 固定兜底句（确定性、≤250 字）
  const fs1 = game.applyFallback(el.state, el.state.queue[0]);
  const fs2 = game.applyFallback(el.state, el.state.queue[0]);
  assert.equal(fs1.error, null, fs1.error);
  assert.deepEqual(fs1.events[0], fs2.events[0]);
  assert.equal(fs1.events[0].type, 'speech');
  assert.ok(fs1.events[0].text.length > 0 && fs1.events[0].text.length <= 200);
  // 投票回退 = 随机存活者且不投自己
  const atVote = autoSpeak(el.state);
  assert.equal(atVote.state.subPhase, 'vote');
  const voter = game.pendingSeat(atVote.state);
  const fv = game.applyFallback(atVote.state, voter);
  assert.equal(fv.error, null, fv.error);
  assert.equal(fv.events[0].type, 'vote');
  assert.notEqual(fv.events[0].target, null);
  assert.notEqual(fv.events[0].target, voter, '回退投票不投自己');
});

test('pendingSeat：各阶段指向正确的待行动座位', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  assert.equal(game.pendingSeat(game.createInitialState()), null, 'lobby 无待行动');
  // §4.1.1 狼阶段：第一个未投票的存活狼；逐狼投票直到全员投完才推进
  assert.equal(game.pendingSeat(s0), Math.min(...seatsOf(s0, 'werewolf')));
  const wolves = seatsOf(s0, 'werewolf');
  let cur = s0;
  for (const w of wolves) {
    assert.equal(game.pendingSeat(cur), w, `按座位序轮到未投票的狼 ${w}`);
    cur = adv(cur, { type: 'wolf_target', seat: w, target: seatsOf(s0, 'villager')[0] }).state;
  }
  assert.equal(game.pendingSeat(cur), seatOf(cur, 'seer'), '全狼投完 → 预言家');
  const t2 = cur.players.find((p) => p.alive && p.role !== 'seer').seat;
  const r2 = adv(cur, { type: 'seer_check', seat: seatOf(cur, 'seer'), target: t2 });
  assert.equal(game.pendingSeat(r2.state), seatOf(s0, 'witch'));
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'save' } });
  // day 1 竞选：首个未表态的存活座；表态一个轮下一个
  assert.equal(game.pendingSeat(peace.state), peace.state.players.find((p) => p.alive).seat, 'elect_join = 首个未表态存活座');
  const er = adv(peace.state, { type: 'elect_run', seat: game.pendingSeat(peace.state), run: false });
  assert.equal(er.error, null, er.error);
  assert.equal(
    game.pendingSeat(er.state),
    peace.state.players.filter((p) => p.alive).map((p) => p.seat)[1],
    '表态完轮到下一个未表态座位'
  );
  const el = autoElect(peace.state); // 回退全员不上警 → 无警长 → 发言
  assert.equal(game.pendingSeat(el.state), el.state.queue[0], '发言阶段 = 队列头');
});

test('纯度：advance / applyFallback 全程不改写入参状态', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const frozen = structuredClone(s0);
  const r = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'poison', target: seatsOf(s0, 'werewolf')[0] } });
  assert.equal(r.error, null);
  const day = autoSpeak(r.state);
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = null;
  castVotes(day.state, votes);
  game.applyFallback(s0, game.wolfCaptain(s0));
  assert.deepEqual(s0, frozen, '所有纯函数不得改写入参状态');
});

/* ---------------- 遗言回退按身份爆信息（2026-10-03 体验修复） ---------------- */

test('遗言回退按身份交代基础信息：民报民+怀疑、女巫报药剂、预言家报验人记录', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  // 平民首夜死 → 遗言回退必须报「我是平民」并给怀疑方向（不再说「我先过」）
  const vDead = seatOf(s0, 'villager');
  const nv = playNight(s0, { blade: vDead, witchMove: { move: 'skip' } });
  assert.equal(nv.state.subPhase, 'lastwords');
  const fv = game.applyFallback(nv.state, nv.state.queue[0]);
  assert.equal(fv.error, null, fv.error);
  assert.equal(fv.events[0].type, 'last_words');
  assert.ok(fv.events[0].text.includes('我是平民'), `遗言应报身份：${fv.events[0].text}`);
  assert.ok(fv.events[0].text.length <= 250, '遗言 ≤250 字');
  // 女巫首夜死（放弃自救）→ 遗言报女巫 + 药剂状态
  const w0 = wolfVoteAll(s0, seatOf(s0, 'witch'));
  const w1 = adv(w0.state, { type: 'seer_check', seat: seatOf(s0, 'seer'), target: seatsOf(s0, 'villager')[1] });
  const w2 = adv(w1.state, { type: 'witch_move', seat: seatOf(s0, 'witch'), move: 'skip' });
  assert.equal(w2.state.subPhase, 'lastwords');
  const fw = game.applyFallback(w2.state, w2.state.queue[0]);
  assert.equal(fw.error, null, fw.error);
  assert.ok(fw.events[0].text.includes('女巫'), `遗言应报女巫：${fw.events[0].text}`);
  assert.ok(fw.events[0].text.includes('解药还在') && fw.events[0].text.includes('毒药还在'), '应交代两瓶药状态');
  // 预言家首夜死（已验过 1 人）→ 遗言报预言家 + 验人记录
  const s1 = wolfVoteAll(s0, seatOf(s0, 'seer'));
  const s2 = adv(s1.state, { type: 'seer_check', seat: seatOf(s0, 'seer'), target: seatsOf(s0, 'villager')[1] });
  const s3 = adv(s2.state, { type: 'witch_move', seat: seatOf(s0, 'witch'), move: 'skip' });
  assert.equal(s3.state.subPhase, 'lastwords');
  const fs = game.applyFallback(s3.state, s3.state.queue[0]);
  assert.equal(fs.error, null, fs.error);
  assert.ok(fs.events[0].text.includes('预言家'), `遗言应报预言家：${fs.events[0].text}`);
  assert.ok(/验.*号/.test(fs.events[0].text), '应交代验人记录');
  // 纯度：遗言回退不改写入参
  const before = JSON.stringify(nv.state);
  game.applyFallback(nv.state, nv.state.queue[0]);
  assert.equal(JSON.stringify(nv.state), before, 'applyFallback 必须是纯函数');
});

/* ---------------- 多板整局收敛（§5.3 整局验收面：守卫板 / 白痴板，ADR-0013） ---------------- */

/** 从任意对局状态用确定性回退驱动到 revealed（同 archive.test playToRevealed / frontend.test 单机整局口径）。
 *  返回 { state, log, subPhases }：subPhases = 路过的 phase:subPhase 集合；log 续接入参数组。 */
function driveToRevealed(s0, log = []) {
  const subPhases = new Set();
  let s = s0;
  let guard = 0;
  while (s.phase !== 'revealed' && guard++ < 500) {
    subPhases.add(`${s.phase}:${s.subPhase}`);
    const seat = game.pendingSeat(s);
    assert.notEqual(seat, null, `对局中应有待行动座位（day=${s.day} ${s.subPhase}）`);
    const r = game.applyFallback(s, seat);
    assert.equal(r.error, null, `回退不应失败（seat=${seat}）：${r.error}`);
    s = r.state;
    log.push(...r.events);
  }
  assert.equal(s.phase, 'revealed', '整局必须收敛');
  return { state: s, log, subPhases };
}

/** 整局公开事件零身份泄漏（同标准板整局口径）。
 *  裁定 2 收窄：仅翻牌类事件（hunter_flip / hunter_shoot）允许 role ∈ {hunter, wolfking}；
 *  词表不含 hunter——守卫 / 白痴板整局可能出现 hunter_flip / hunter_skip 事件类型名
 *  （类型名含 hunter 子串，非身份泄漏），role 字段由逐事件断言把守。 */
function assertNoRoleLeak(log, extraWords = []) {
  const json = JSON.stringify(log);
  for (const word of ['werewolf', 'villager', 'seer', 'witch', 'wolfking', ...extraWords]) {
    assert.ok(!json.includes(word), `公开事件泄漏了身份词：${word}`);
  }
  assert.ok(
    log.every((e) => {
      if (e.type === 'hunter_flip' || e.type === 'hunter_shoot') {
        return e.role === undefined || e.role === 'hunter' || e.role === 'wolfking';
      }
      return !('role' in e);
    }),
    '非翻牌类公开事件不得携带 role 字段'
  );
}

test('整局推进（守卫板）：回退驱动收敛到终局，守卫守护步整局参与；全程公开事件零身份泄漏', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 7, 'guard');
  assert.equal(s0.board, 'guard');
  const { state, log, subPhases } = driveToRevealed(s0);
  assert.ok(state.winner === 'good' || state.winner === 'wolf');
  assert.ok(subPhases.has('night:guard'), '守卫板整局必须走到守卫守护步（§1.3 夜顺序插入位）');
  assert.ok(state.guard, '守卫持久态（guard.last）保留到终局供复盘');
  assertNoRoleLeak(log, ['guard', 'idiot']);
});

test('整局推进（白痴板）：day 1 真实投票放逐白痴翻牌免死 → 余局回退驱动收敛；全程公开事件零身份泄漏', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42, 'idiot');
  const id = seatOf(s0, 'idiot');
  // N1：真实动作链刀一个平民（同标准板整局口径）
  const nv = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'skip' } });
  assert.equal(nv.error, null);
  const log = [...nv.events];
  // D1：竞选回退（全员不上警）+ 遗言 / 发言回退 → 停在 vote
  const day = autoSpeak(nv.state);
  log.push(...day.events);
  assert.equal(day.state.subPhase, 'vote');
  // 全员票投白痴（本人弃票）→ 翻牌免死，平安日式直接入夜（§1.4）
  const votes = {};
  for (const p of day.state.players) if (p.alive) votes[p.seat] = p.seat === id ? null : id;
  const v1 = castVotes(day.state, votes);
  log.push(...v1.events);
  const res = v1.events.find((e) => e.type === 'vote_result');
  assert.equal(res.exiled, id);
  assert.equal(res.idiot, true, '整局里白痴翻牌免死照常触发（vote_result.idiot 公开宣告）');
  assert.equal(at(v1.state, id).alive, true, '翻牌白痴不入死');
  assert.equal(at(v1.state, id).idiotRevealed, true);
  assert.equal(v1.state.phase, 'night', '放逐检查点后直接进夜');
  // 余局全回退驱动收敛：翻牌白痴无票（votersOf 口径）与发言权保留在整局中自动生效（回退链不卡死）
  const { state, subPhases } = driveToRevealed(v1.state, log);
  assert.ok(state.winner === 'good' || state.winner === 'wolf');
  assert.ok(subPhases.has('day:vote'), '后续白天照常进入投票（翻牌白痴不在待投名单）');
  assertNoRoleLeak(log, ['guard']); // idiot 是 t-schema 公开字段名（vote_result.idiot），不入泄漏词表
});

/* ---------------- 旧态兼容（部署过渡防回归：main 部署形状状态推进不崩，§10.3 旧局容错） ---------------- */

/** 剥成 main 部署形状（部署过渡兜底所针对的旧持久化状态）：无 board/seed/guard/sheriff/badge、
 *  night 无 guardTarget、玩家无 idiotRevealed。纯函数：不改写入参。 */
function toLegacyShape(state) {
  const s = structuredClone(state);
  delete s.board;
  delete s.seed;
  delete s.guard;
  delete s.sheriff;
  delete s.badge;
  if (s.night) delete s.night.guardTarget;
  for (const p of s.players) if (p) delete p.idiotRevealed;
  return s;
}

test('旧态兼容：main 部署 lobby（无 guard/sheriff/badge）直接开局——hStart 部署过渡兜底回填三字段', () => {
  const lobby = toLegacyShape(game.createInitialState());
  assert.equal('guard' in lobby, false, '前置：lobby 形状已剥成 main 部署形状');
  let s = lobby;
  ['张三', '李四', '王五'].forEach((nick, i) => {
    const r = adv(s, { type: 'join', nick, uid: `u${i + 1}` });
    assert.equal(r.error, null, `join 不应失败：${r.error}`);
    s = r.state;
  });
  for (let seat = 1; seat <= 3; seat++) s = adv(s, { type: 'ready', seat, ready: true }).state;
  const r = adv(s, { type: 'start', seed: 42 });
  assert.equal(r.error, null, `旧 lobby 开局不应失败：${r.error}`);
  assert.equal('guard' in r.state, true, 'guard 持久态回填（shared/game.js 部署过渡兜底）');
  assert.equal('sheriff' in r.state, true, 'sheriff 状态回填');
  assert.equal('badge' in r.state, true, 'badge 标记回填');
  assert.equal(r.state.board, 'standard', '旧客户端不传 board → 缺省 standard');
  assert.equal(r.state.phase, 'night');
});

test('旧态兼容：main 部署形状的夜 1 对局态继续推进——密聊 / 定刀回填、day 1 不进竞选、新子阶段动作按阶段拒绝、整局收敛', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const legacy = toLegacyShape(s0);
  // 剥离生效：旧 worker 持久化的对局态没有本批任何新字段
  assert.equal('board' in legacy, false);
  assert.equal('guard' in legacy, false);
  assert.equal('sheriff' in legacy, false);
  assert.equal('badge' in legacy, false);
  assert.equal('guardTarget' in legacy.night, false);
  // 夜 1：密聊与定刀照常（hWolfChat / hWolfTarget 部署过渡兜底补 wolfChatLog / night.wolfVotes）
  const wolves = seatsOf(legacy, 'werewolf');
  const chat = adv(legacy, { type: 'wolf_chat', seat: wolves[0], text: '旧房密聊' });
  assert.equal(chat.error, null, `旧态密聊不应失败：${chat.error}`);
  assert.ok(Array.isArray(chat.state.wolfChatLog) && chat.state.wolfChatLog.length === 1, 'wolfChatLog 兜底回填');
  let s = chat.state;
  for (const w of wolves) {
    const r = adv(s, { type: 'wolf_target', seat: w, target: seatsOf(s, 'villager')[0] });
    assert.equal(r.error, null, `旧态定刀不应失败：${r.error}`);
    s = r.state;
  }
  assert.equal(s.subPhase, 'seer', '标准板无守卫 → 定刀后直进预言家（enterGuard 跳过不依赖 s.guard）');
  assert.equal(game.pendingSeat(s), seatOf(s, 'seer'), '旧态 pendingSeat 照常探查');
  s = adv(s, { type: 'seer_check', seat: seatOf(s, 'seer'), target: seatsOf(s, 'villager')[1] }).state;
  s = adv(s, { type: 'witch_move', seat: seatOf(s, 'witch'), move: 'skip' }).state;
  // 天亮 → day 1：旧房不进竞选（s.sheriff 缺失 → enterElectionOrSpeak 直通发言链，与 main 部署行为一致）
  assert.equal(s.phase, 'day');
  assert.ok(!String(s.subPhase).startsWith('elect'), '旧房 day 1 不得进入警长竞选（s.sheriff 缺失即跳过）');
  assert.equal(s.night, null, '天亮清空当夜瞬时信息（含缺失的 guardTarget 语义）');
  // 新子阶段动作在旧态上按阶段校验拒绝：fail 不抛错、原状态返回
  for (const a of [
    { type: 'guard_protect', seat: 2, target: 3 },
    { type: 'elect_run', seat: 2, run: true },
    { type: 'elect_vote', seat: 2, target: 3 },
    { type: 'badge_move', seat: 2, target: 3 },
  ]) {
    const r = adv(s, a);
    assert.ok(typeof r.error === 'string' && r.error.length > 0, `旧态 ${a.type} 应被阶段校验拒绝（不崩）`);
  }
  // 余局全回退驱动收敛：advance / pendingSeat / applyFallback 全子阶段不崩（每步断言无错误）
  const { state } = driveToRevealed(s);
  assert.ok(state.winner === 'good' || state.winner === 'wolf');
});
