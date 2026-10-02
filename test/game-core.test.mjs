/* ============================================================
 * test/game-core.test.mjs —— shared/game.js 内核测试（node --test 自动发现）
 * 口径对照 docs/features.md（冻结版）：§3 板子 / §4 昼夜流程 /
 *   §4.2.6 平票 PK / §5 关键口径 / §5.7 胜负 / §7.4–7.5 AI 补位 / §8.4 回退。
 * 覆盖：发牌、夜晚结算、平票、胜负、补位各至少一例，外加各非平凡分支。
 * 固定种子（mulberry32）保证全部用例可复现。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../shared/game.js';

const adv = (s, a) => game.advance(s, a);
const at = (s, seat) => s.players[seat - 1];
const seatOf = (s, role) => s.players.find((p) => p && p.role === role).seat;
const seatsOf = (s, role) => s.players.filter((p) => p && p.role === role).map((p) => p.seat);

/** 建房 → 加入 → 全员准备 → start（带种子）。 */
function newRoom(nicks, seed = 42) {
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
  const r = adv(s, { type: 'start', seed });
  assert.equal(r.error, null, `start 不应失败：${r.error}`);
  return { state: r.state, events: r.events };
}

/** 打完一整夜（狼刀 → 验人 → 用药 → 结算）。返回最后一次 advance 的结果（含天亮公告）。 */
function playNight(s, { blade, check, witchMove }) {
  let r = adv(s, { type: 'wolf_target', seat: game.wolfCaptain(s), target: blade });
  assert.equal(r.error, null, `wolf_target 不应失败：${r.error}`);
  s = r.state;
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

/** 用确定性回退自动跑完遗言 / 发言 / PK 发言（含被放逐者遗言，死者也可发遗言），停在下一个非发言阶段。 */
function autoSpeak(s) {
  const events = [];
  const SPEAKISH = ['lastwords', 'exile_lastwords', 'speak', 'pk_speak'];
  let guard = 0;
  while (SPEAKISH.includes(s.subPhase)) {
    const seat = s.queue[0];
    const r = game.applyFallback(s, seat);
    assert.equal(r.error, null, `回退发言不应失败 @${seat}：${r.error}`);
    s = r.state;
    events.push(...r.events);
    guard += 1;
    assert.ok(guard < 100, 'autoSpeak 必须终止');
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

/** 平安夜（女巫救刀）→ 白天发言完毕，停在 vote。 */
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
  assert.deepEqual(count, game.BOARD, '角色构成必须等于板子定义');
  assert.equal(a.state.players.length, game.SEAT_COUNT);
  assert.equal(a.state.phase, 'night');
  assert.equal(a.state.day, 1);
  assert.equal(a.state.subPhase, 'wolf');
  // §7.5：AI-1…AI-6 按补位（座位升序）分配，昵称即公开 AI 标识
  assert.deepEqual(a.state.players.slice(3).map((p) => p.nick), ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6']);
  assert.ok(a.state.players.slice(3).every((p) => p.isAI));
  assert.ok(a.state.players.slice(0, 3).every((p) => !p.isAI));
  // game_start 事件不带 role（暗牌）
  const gs = a.events.find((e) => e.type === 'game_start');
  assert.equal(gs.players.length, 9);
  assert.ok(gs.players.every((p) => !('role' in p)));
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
  assert.equal(r.state.subPhase, 'speak', '无死亡 → 无遗言 → 直接发言');
  assert.ok(r.state.players.every((p) => p.alive));
  assert.equal(r.state.witch.antidote, 0, '解药全局一瓶，用掉即清零');
  assert.equal(r.state.witch.poison, 1);
});

test('夜晚结算：刀与毒各杀一人 → 天亮一次性公布双死者并进首夜遗言；夜间子阶段不产生公开事件', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolf = seatsOf(s0, 'werewolf')[0];
  const v1 = seatsOf(s0, 'villager')[0];
  const v2 = seatsOf(s0, 'villager')[1];
  const r1 = adv(s0, { type: 'wolf_target', seat: game.wolfCaptain(s0), target: v1 });
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
  const w1 = adv(d1.state, { type: 'wolf_target', seat: game.wolfCaptain(d1.state), target: witchA });
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
  const wb1 = adv(d1b.state, { type: 'wolf_target', seat: game.wolfCaptain(d1b.state), target: witchB });
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
  const r1 = adv(s0, { type: 'wolf_target', seat: game.wolfCaptain(s0), target: v0 });
  const r2 = adv(r1.state, { type: 'seer_check', seat: seer, target: wolf });
  assert.equal(r2.error, null);
  assert.deepEqual(r2.state.seerChecks, [{ night: 1, target: wolf, isWolf: true }]);
  assert.equal(r2.state.subPhase, 'witch');
  const roomB = newRoom(['张三', '李四', '王五'], 43);
  const rb = adv(roomB.state, { type: 'wolf_target', seat: game.wolfCaptain(roomB.state), target: seatsOf(roomB.state, 'villager')[0] });
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
  // 全程公开事件零身份泄漏：无 role 字段、无角色词（昵称只有张三/李四/王五/AI-n）
  const json = JSON.stringify(log);
  for (const word of ['werewolf', 'villager', 'seer', 'witch', 'hunter']) {
    assert.ok(!json.includes(word), `公开事件泄漏了身份词：${word}`);
  }
  assert.ok(log.every((e) => !('role' in e)));
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

/* ---------------- 狼队长（§5.1） ---------------- */

test('狼队长：真人优先，多人取座位号最小；否则座位号最小 AI 狼', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const wolves = seatsOf(s0, 'werewolf');
  const humanWolves = wolves.filter((x) => x <= 3); // 座位 1–3 是真人
  const expect = humanWolves.length > 0 ? Math.min(...humanWolves) : Math.min(...wolves);
  assert.equal(game.wolfCaptain(s0), expect);
  // 全部真人狼死后由 AI 狼接任（白盒：标记真人狼死亡）
  const s = structuredClone(s0);
  for (const x of humanWolves) s.players[x - 1].alive = false;
  const aiWolves = wolves.filter((x) => x > 3).filter((x) => s.players[x - 1].alive);
  if (aiWolves.length > 0) assert.equal(game.wolfCaptain(s), Math.min(...aiWolves));
  else assert.equal(game.wolfCaptain(s), null);
});

/* ---------------- 行动校验与纯度 ---------------- */

test('行动校验：越权 / 非法目标 / 错误阶段一律拒绝，失败时返回原状态引用且零事件', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const cap = game.wolfCaptain(s0);
  const notCap = s0.players.find((p) => p.alive && p.seat !== cap).seat;
  assert.equal(adv(s0, { type: 'wolf_target', seat: notCap, target: 1 }).error, '只有狼队长可以定刀');
  const bad = adv(s0, { type: 'wolf_target', seat: notCap, target: 1 });
  assert.equal(bad.state, s0, '失败必须原样返回入参状态（纯函数）');
  assert.deepEqual(bad.events, []);
  // 刀口必须存活（不可空刀）
  const sDead = structuredClone(s0);
  sDead.players[3].alive = false; // 白盒：座位 4 已死
  assert.equal(adv(sDead, { type: 'wolf_target', seat: game.wolfCaptain(sDead), target: 4 }).error, '刀口必须是存活玩家（狼不可空刀，§5.10）');
  // 错误阶段
  const sSeer = adv(s0, { type: 'wolf_target', seat: cap, target: 1 }).state;
  assert.equal(adv(sSeer, { type: 'wolf_target', seat: cap, target: 2 }).error, '当前不是狼人定刀阶段');
  assert.equal(adv(sSeer, { type: 'speak', seat: 1, text: 'x' }).error, '当前不是可发言阶段');
  assert.equal(adv(sSeer, { type: 'vote', seat: 1, target: 2 }).error, '当前不是投票阶段');
  assert.equal(adv(sSeer, { type: 'hunter_shoot', seat: seatOf(s0, 'hunter'), target: 1 }).error, '当前不是猎人开枪阶段');
  // 发言：未轮到 / 超过 200 字 / 空
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'save' } });
  assert.equal(peace.state.subPhase, 'speak');
  const head = peace.state.queue[0];
  const other = peace.state.queue[1];
  assert.equal(adv(peace.state, { type: 'speak', seat: other, text: '抢话' }).error, '还没轮到该座位发言');
  assert.equal(adv(peace.state, { type: 'speak', seat: head, text: 'x'.repeat(201) }).error, '发言不得超过 200 字');
  assert.equal(adv(peace.state, { type: 'speak', seat: head, text: '   ' }).error, '发言不能为空');
  const good = adv(peace.state, { type: 'speak', seat: head, text: '我是好人。' });
  assert.equal(good.error, null);
  // 死人不能投票
  const atVote = autoSpeak(good.state);
  assert.equal(atVote.state.subPhase, 'vote');
  const vsDead = structuredClone(atVote.state);
  vsDead.players[0].alive = false; // 白盒：座位 1 已死
  assert.equal(adv(vsDead, { type: 'vote', seat: 1, target: 2 }).error, '只有存活玩家可以投票');
  // 猎人枪死目标
  const sHunt = structuredClone(peace.state);
  sHunt.phase = 'day';
  sHunt.subPhase = 'hunter';
  sHunt.pendingHunter = seatOf(s0, 'hunter');
  sHunt.players[2].alive = false;
  assert.equal(adv(sHunt, { type: 'hunter_shoot', seat: seatOf(s0, 'hunter'), target: 3 }).error, '枪目标必须是存活玩家');
  // 未知动作 / revealed 只读
  assert.equal(adv(s0, { type: 'dance' }).error, '未知动作类型：dance');
  const sRev = structuredClone(peace.state);
  sRev.phase = 'revealed';
  assert.ok(adv(sRev, { type: 'speak', seat: 1, text: 'x' }).error, '终局后应拒绝动作');
});

/* ---------------- 确定性回退（§8.4）与 pendingSeat ---------------- */

test('确定性回退：同状态同结果；狼刀随机存活、女巫跳过、猎人不开枪、发言固定兜底句、投票不投自己', () => {
  const { state: s0 } = newRoom(['张三', '李四', '王五'], 42);
  const cap = game.wolfCaptain(s0);
  // 狼刀回退：随机存活玩家（确定性 = 同状态必同结果）
  const fa = game.applyFallback(s0, cap);
  const fb = game.applyFallback(s0, cap);
  assert.equal(fa.error, null, fa.error);
  assert.deepEqual(fa.state, fb.state, '回退必须是纯函数');
  assert.ok(at(s0, fa.state.night.blade).alive, '回退刀口必须是存活玩家');
  // 女巫回退 = 跳过 → 直接天亮结算
  const w1 = adv(s0, { type: 'wolf_target', seat: cap, target: seatsOf(s0, 'villager')[0] });
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
  // 死者的遗言也有回退（首夜死者猎人翻牌放弃后）
  const skip = adv(hn.state, { type: 'hunter_shoot', seat: hunter, target: null }).state;
  assert.equal(skip.subPhase, 'lastwords');
  const lw = game.applyFallback(skip, skip.queue[0]);
  assert.equal(lw.error, null, lw.error);
  assert.equal(lw.events[0].type, 'last_words');
  assert.equal(lw.state.subPhase, 'speak');
  // 发言回退 = 固定兜底句（确定性、≤200 字）
  const fs1 = game.applyFallback(lw.state, lw.state.queue[0]);
  const fs2 = game.applyFallback(lw.state, lw.state.queue[0]);
  assert.equal(fs1.error, null, fs1.error);
  assert.deepEqual(fs1.events[0], fs2.events[0]);
  assert.equal(fs1.events[0].type, 'speech');
  assert.ok(fs1.events[0].text.length > 0 && fs1.events[0].text.length <= 200);
  // 投票回退 = 随机存活者且不投自己
  const atVote = autoSpeak(lw.state);
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
  assert.equal(game.pendingSeat(s0), game.wolfCaptain(s0));
  const t1 = s0.players.find((p) => p.alive && p.seat !== game.wolfCaptain(s0)).seat;
  const r1 = adv(s0, { type: 'wolf_target', seat: game.wolfCaptain(s0), target: t1 });
  assert.equal(game.pendingSeat(r1.state), seatOf(s0, 'seer'));
  const t2 = s0.players.find((p) => p.alive && p.role !== 'seer').seat;
  const r2 = adv(r1.state, { type: 'seer_check', seat: seatOf(s0, 'seer'), target: t2 });
  assert.equal(game.pendingSeat(r2.state), seatOf(s0, 'witch'));
  const peace = playNight(s0, { blade: seatsOf(s0, 'villager')[0], witchMove: { move: 'save' } });
  assert.equal(game.pendingSeat(peace.state), peace.state.queue[0], '发言阶段 = 队列头');
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
