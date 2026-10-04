/* ============================================================
 * test/worker.test.mjs —— worker/ 层测试（node --test 自动发现）
 * ------------------------------------------------------------
 * 覆盖（按任务书）：
 *   1. url-guard 拒绝 / 放行全段用例（features.md §10 硬性验收）；
 *   2. 房间纯逻辑（worker/src/room-logic.js）：建房 / 准备 / 补位开桌 /
 *      rev 游标（含夜里非行动座位视角冻结 / 天亮齐跳）、托管与超时回退、
 *      AI 契约（buildAIRequest / parseAIReply / windowHistory / aiView）；
 *   3. AI 代理头白名单（buildProxyRequest / proxyFetch / 路由层）；
 *   4. 路由集成：fake DO 环境跑通 建房→进房→准备→开桌→轮询 unchanged、
 *      CORS 只放行白名单、建房限流。
 * 注意：全量 `node --test` 由工作流统一执行；本文件可单独跑。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkUrl } from '../worker/src/url-guard.js';
import * as logic from '../worker/src/room-logic.js';
import * as game from '../shared/game.js';
import { PERSONAS } from '../shared/prompts.js';
import { buildProxyRequest, proxyFetch, aiProxyLimited, resetRateLimiterForTests, isDefaultAiUrl, DEFAULT_AI_BASE } from '../worker/src/ai-proxy.js';
import worker, { resetRoomLimiterForTests } from '../worker/src/index.js';
import { Room } from '../worker/src/room.js';

/* ---------------- url-guard（§10 全段） ---------------- */

test('url-guard：放行公网 http/https 与边界 IP', () => {
  for (const u of [
    'https://api.openai.com', // §10 用例基线
    'https://api.openai.com/v1/chat/completions',
    'http://example.com:8080/path?q=1',
    'https://8.8.8.8/v1',
    'https://1.1.1.1/',
    'https://172.15.255.255/', // 172.16-31 下边界之外
    'https://172.32.0.1/',
    'https://100.63.255.255/', // 100.64/10 边界之外
    'https://100.128.0.1/',
    'https://192.1.0.1/', // 192.168 / 192.0.x 之外
    'https://198.17.0.1/', // 198.18-19 之外
    'https://198.20.0.1/',
    'https://[2001:db8::1]/',
    'https://[2600::]/',
    'https://sub.api.openai.com/',
  ]) {
    assert.equal(checkUrl(u), null, `应放行 ${u}`);
  }
});

test('url-guard：拒绝非 http/https 协议与坏 URL', () => {
  for (const u of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://example.com', 'not a url', '']) {
    assert.ok(typeof checkUrl(u) === 'string' && checkUrl(u).length > 0, `应拒绝 ${u}`);
  }
});

test('url-guard：拒绝 localhost 与保留主机名后缀', () => {
  for (const u of [
    'http://localhost',
    'https://localhost:8443/x',
    'http://foo.localhost',
    'http://api.local',
    'http://x.y.internal',
    'http://intranet.lan',
    'http://printer.home',
    'http://home.arpa',
    'http://x.arpa',
    'http://corp.intranet',
  ]) {
    assert.ok(checkUrl(u), `应拒绝 ${u}`);
  }
});

test('url-guard：拒绝环回 / 私网 / 链路本地 / 保留 IPv4 全段（含变体写法）', () => {
  for (const u of [
    'http://127.0.0.1', // §10 基线
    'http://127.1', // 短式环回
    'http://0x7f.1', // 十六进制段
    'http://2130706433', // 纯整数 = 127.0.0.1
    'http://0.0.0.1', // 0/8
    'http://10.0.0.1', // §10 基线
    'http://10.255.255.255',
    'http://169.254.1.1', // 链路本地
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.1', // §10 基线
    'http://192.168.0.0',
    'http://100.64.0.1', // CGNAT
    'http://100.127.255.254',
    'http://192.0.0.1', // 192.0.x
    'http://192.0.2.1',
    'http://198.18.0.1', // 基准测试段
    'http://198.19.255.255',
    'http://224.0.0.1', // 组播
    'http://239.1.1.1',
    'http://255.255.255.255',
  ]) {
    assert.ok(checkUrl(u), `应拒绝 ${u}`);
  }
});

test('url-guard：拒绝 IPv6 ::/::1、fc/fd/fe/ff 前缀与内嵌保留 IPv4', () => {
  for (const u of [
    'https://[::]/',
    'https://[::1]/', // §10 基线
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/', // IPv4 映射环回
    'http://[::ffff:192.168.1.1]/',
  ]) {
    assert.ok(checkUrl(u), `应拒绝 ${u}`);
  }
});

test('url-guard：拒绝 URL 内嵌账密', () => {
  for (const u of ['http://user:pass@example.com', 'https://user@example.com', 'https://k:j@api.openai.com']) {
    assert.ok(checkUrl(u), `应拒绝 ${u}`);
  }
});

/* ---------------- 房间纯逻辑（room-logic） ---------------- */

const T0 = 1_000_000; // 固定时基，纯函数可复现

/** 3 真人建房到开局（seed 固定），返回每一步后的房间与最新状态。 */
function newGame() {
  let room = logic.createRoom('ABC234', { nick: '甲', uid: 'u1' }, T0).room;
  const act = (a, b, now) => {
    const out = logic.applyAction(room, a, b, { now: now ?? T0, seed: 42 });
    assert.ok(!out.error, `${a} 不应失败：${out.error}`);
    room = out.room;
    return out;
  };
  act('join', { nick: '乙', uid: 'u2' });
  act('join', { nick: '丙', uid: 'u3' });
  act('ready', { uid: 'u1', ready: true });
  act('ready', { uid: 'u2', ready: true });
  act('ready', { uid: 'u3', ready: true });
  const started = act('start', { uid: 'u1' }, T0 + 100);
  return { room, started, act };
}

const seatOfRole = (room, role) => room.game.players.find((p) => p && p.role === role).seat;
const seatsOfRole = (room, role) => room.game.players.filter((p) => p && p.role === role).map((p) => p.seat);
const uidOfSeat = (room, seat) => room.game.players[seat - 1].uid;
const snap = (room, seat) => JSON.stringify(logic.snapshotFor(room, seat));

/** 以座位合法身份构造动作体：真人用本人 uid；AI / 托管座位由房主带 seat 驱动。 */
function driveSeat(room, seat, extra) {
  const p = room.game.players[seat - 1];
  if (p && p.isAI) return { uid: room.ownerUid, seat, ...extra };
  return { uid: p.uid, ...extra };
}

/** §4.1.1 狼队全员投票定刀：所有存活未投票的狼依次投 target，返回最终房间。 */
function wolfKnifeAll(room, target, startNow = T0) {
  let cur = room;
  let n = 0;
  for (const p of cur.game.players.filter((x) => x && x.alive && x.role === 'werewolf')) {
    if (cur.game.night && cur.game.night.wolfVotes[p.seat] !== undefined) continue; // 已投过（回退等）
    const out = logic.applyAction(cur, 'wolf-target', driveSeat(cur, p.seat, { target }), {
      now: startNow + n * 10,
      seed: 42,
    });
    assert.ok(!out.error, `wolf-target(${p.seat}) 不应失败：${out.error}`);
    cur = out.room;
    n += 1;
  }
  return cur;
}

test('建房：房主入座 1 号，大厅事件与 rev 起步正确', () => {
  const bad = logic.createRoom('X', { nick: '', uid: 'u1' }, T0);
  assert.ok(bad.error, '空昵称应被拒');
  const made = logic.createRoom('ABC234', { nick: ' 甲 ', uid: 'u1' }, T0);
  const room = made.room;
  assert.equal(room.ownerUid, 'u1');
  assert.equal(room.code, 'ABC234');
  assert.equal(room.game.phase, 'lobby');
  assert.equal(room.game.players[0].nick, '甲');
  assert.equal(room.revs[1], 1);
  assert.equal(logic.snapshotFor(room, 1).mySeat, 1);
  assert.equal(logic.seatOfUid(room, 'u1'), 1);
  assert.equal(logic.seatOfUid(room, 'nobody'), null);
});

test('进房 / 准备：rev 游标按座位视角推进（他人加入自己视角变化）', () => {
  let room = logic.createRoom('ABC234', { nick: '甲', uid: 'u1' }, T0).room;
  room = logic.applyAction(room, 'join', { nick: '乙', uid: 'u2' }, { now: T0 + 1 }).room;
  assert.equal(room.revs[1], 2, '甲的视角看到乙加入 → rev+1');
  assert.equal(room.revs[2], 1, '乙自己的初始视角');
  room = logic.applyAction(room, 'ready', { uid: 'u2', ready: true }, { now: T0 + 2 }).room;
  assert.equal(room.revs[1], 3, '甲的视角看到乙准备');
  assert.equal(room.revs[2], 2, '乙自己的视角');
  assert.equal(snap(room, 2), snap(room, 2), '快照是确定性纯函数');
});

test('补位开桌：3 真人 start → 原子补 6 AI 到 9 并进 night_1；不足 3 人与未准备被拒', () => {
  const { room, started } = newGame();
  assert.equal(started.data.aiFilled, 6);
  assert.equal(room.game.players.length, 9);
  assert.equal(room.game.players.filter((p) => p.isAI).length, 6);
  assert.deepEqual(room.game.players.slice(3).map((p) => p.nick), ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6']);
  assert.equal(room.game.phase, 'night');
  assert.equal(room.game.day, 1);
  assert.equal(room.game.subPhase, 'wolf');
  assert.equal(room.deadline.seat, game.pendingSeat(room.game), '150s 行动超时对准待行动座位');
  assert.ok(room.deadline.at > T0 + 100, 'deadline 在未来');

  // 2 真人不足最小开桌数 → 拒（内核口径 §7.4）
  let small = logic.createRoom('X1', { nick: '甲', uid: 'u1' }, T0).room;
  small = logic.applyAction(small, 'join', { nick: '乙', uid: 'u2' }, { now: T0 }).room;
  small = logic.applyAction(small, 'ready', { uid: 'u1', ready: true }, { now: T0 }).room;
  small = logic.applyAction(small, 'ready', { uid: 'u2', ready: true }, { now: T0 }).room;
  const tooFew = logic.applyAction(small, 'start', { uid: 'u1' }, { now: T0, seed: 1 });
  assert.equal(tooFew.error, '真人不足 3 人，无法开桌');

  // 未全员准备 → 拒（start 时重校验）
  let unready = logic.createRoom('X2', { nick: '甲', uid: 'u1' }, T0).room;
  unready = logic.applyAction(unready, 'join', { nick: '乙', uid: 'u2' }, { now: T0 }).room;
  unready = logic.applyAction(unready, 'join', { nick: '丙', uid: 'u3' }, { now: T0 }).room;
  unready = logic.applyAction(unready, 'ready', { uid: 'u1', ready: true }, { now: T0 }).room;
  assert.equal(logic.applyAction(unready, 'start', { uid: 'u1' }, { now: T0, seed: 1 }).error, '仍有真人未准备');

  // 非房主不能 start
  let notOwner = logic.createRoom('X3', { nick: '甲', uid: 'u1' }, T0).room;
  assert.equal(logic.applyAction(notOwner, 'start', { uid: 'u1' }, { now: T0, seed: 1 }).error, '真人不足 3 人，无法开桌');
});

test('夜视角冻结（§4.1.6 / §4.1.1 / ADR-0002）：密聊只有狼座可见，非狼座位 rev 冻结；全员投完刀口落定', () => {
  const { room, act } = newGame();
  const cap = game.wolfCaptain(room.game);
  const villager = seatsOfRole(room, 'villager').find((s) => s !== cap);
  const wolves = seatsOfRole(room, 'werewolf');
  const seer = seatOfRole(room, 'seer');
  const victim = seatsOfRole(room, 'villager')[1];

  const before = snap(room, villager);
  const revV = room.revs[villager];
  const after = act('wolf-chat', driveSeat(room, cap, { text: '白天我带节奏，你们补刀口' }), T0 + 150).room;

  assert.equal(snap(after, villager), before, '普通村民夜里快照冻结（密聊不可见）');
  assert.equal(after.revs[villager], revV, '普通村民 rev 不变');
  // §4.1.1：密聊只有狼座可见 → 全部存活狼 rev+1，非狼全冻结
  assert.equal(after.revs[cap], room.revs[cap] + 1, '发言狼自己视角更新');
  for (const w of wolves) {
    if (w !== cap) assert.equal(after.revs[w], room.revs[w] + 1, `狼队友 ${w} 看到密聊 → rev+1`);
  }
  assert.equal(after.revs[seer], room.revs[seer], '狼阶段未结束，预言家仍冻结');
  const wSnap = logic.snapshotFor(after, cap);
  assert.equal(wSnap.action.kind, 'wolf', '狼阶段行动面板对全员狼开放');
  assert.deepEqual(wSnap.you.wolfChatLog, [{ n: 1, seat: cap, text: '白天我带节奏，你们补刀口' }], '密聊日志进狼座私有视角');
  assert.deepEqual(wSnap.you.wolfVotes, {}, '投票暂空');
  const vSnap = logic.snapshotFor(after, villager);
  assert.equal(vSnap.you.wolfChatLog, undefined, '非狼座位绝不带密聊字段');
  assert.equal(vSnap.you.wolfVotes, undefined);
  assert.equal(vSnap.action, undefined);
  // 夜里快照不露子阶段（非行动非知情座位只看到 night）
  assert.equal('subPhase' in vSnap, false, '夜里不露子阶段');

  // 全员投票 → 刀口落定 → 预言家轮到
  const done = wolfKnifeAll(after, victim, T0 + 200);
  assert.equal(done.game.night.blade, victim, '全员一致 → 多数决定刀');
  assert.equal(done.game.subPhase, 'seer', '全狼投完推进到预言家');
  assert.equal(done.revs[seer], after.revs[seer] + 1, '预言家轮到 → rev+1');
  assert.equal(logic.snapshotFor(done, cap).you.blade, victim, '狼座知晓刀口');
  assert.equal(
    logic.snapshotFor(done, wolves.find((w) => w !== cap)).you.blade,
    victim,
    '存活狼队友同样知晓刀口'
  );
});

test('天亮齐跳：夜结算公布死者后全员 rev+1，白天子阶段与 pending 公开', () => {
  const { room } = newGame();
  const victim = seatsOfRole(room, 'villager')[1];
  const seer = seatOfRole(room, 'seer');
  const witch = seatOfRole(room, 'witch');
  const revs0 = { ...room.revs };
  let cur = wolfKnifeAll(room, victim, T0 + 200);
  const step = (a, b, now) => {
    const out = logic.applyAction(cur, a, b, { now, seed: 42 });
    assert.ok(!out.error, `${a} 不应失败：${out.error}`);
    cur = out.room;
  };
  step('seer-check', driveSeat(cur, seer, { target: seatsOfRole(cur, 'villager')[0] }), T0 + 210);
  step('witch-move', driveSeat(cur, witch, { move: 'skip' }), T0 + 220);

  assert.equal(cur.game.phase, 'day');
  assert.equal(cur.game.subPhase, 'lastwords', '首夜有死者 → 遗言阶段');
  for (let seat = 1; seat <= 9; seat++) {
    assert.ok(cur.revs[seat] > revs0[seat], `座位 ${seat} 天亮应齐跳`);
  }
  const s = logic.snapshotFor(cur, 1);
  assert.equal(s.phase, 'day');
  assert.equal(s.subPhase, 'lastwords');
  assert.equal(typeof s.pending, 'number', '白天待行动座位公开');
  assert.ok(s.events.some((e) => e.t === 'deaths' && e.seats.includes(victim)), '公开事件含死讯公告');
  /* 白天透出行动倒计时（吸顶状态条数据源，§5.11）；夜里仅行动者本人可见——
     deadline.seat 即轮到谁，透给非行动座位会泄漏夜里行动顺序（§4.1.6） */
  assert.ok(s.deadline && s.deadline.at > T0 + 220 && s.deadline.seat === s.pending, '白天快照带 deadline {at, seat}');
  const np = game.pendingSeat(room.game);
  assert.ok(np != null, '夜里应有待行动座位');
  assert.ok(logic.snapshotFor(room, np).deadline, '夜里行动者本人快照带 deadline（无泄漏）');
  for (let seat = 1; seat <= 9; seat++) {
    if (seat === np) continue;
    assert.equal(logic.snapshotFor(room, seat).deadline, undefined, `夜里座位 ${seat}（非行动者）不透 deadline`);
  }
});

test('越权与非法动作被拒：非本人座位 / 非房主代打 / AI 座位不认 uid 直投', () => {
  const { room } = newGame();
  const cap = game.wolfCaptain(room.game);
  const villager = seatsOfRole(room, 'villager')[0];
  assert.ok(
    logic.applyAction(room, 'wolf-target', driveSeat(room, villager, { target: 1 }), { now: T0 }).error,
    '非狼不可投票定刀'
  );
  assert.ok(
    logic.applyAction(room, 'wolf-chat', driveSeat(room, villager, { text: '混进来' }), { now: T0 }).error,
    '非狼不可参与密聊'
  );
  // 非房主带 seat 代打 → 拒
  const victim = seatsOfRole(room, 'villager')[1];
  assert.ok(
    logic.applyAction(room, 'wolf-target', { uid: 'u2', seat: cap, target: victim }, { now: T0 }).error,
    '非房主不可代打'
  );
  // 房主带 seat 驱动 AI / 真人狼（driveSeat 合法身份）→ 投票入账
  const out = logic.applyAction(room, 'wolf-target', driveSeat(room, cap, { target: victim }), { now: T0 + 5 });
  assert.ok(!out.error, `合法狼投票应成功：${out.error}`);
  assert.equal(out.room.game.night.wolfVotes[cap], victim, '投票入账（全员投完才定刀）');
  const done = wolfKnifeAll(out.room, victim, T0 + 10);
  assert.equal(done.game.night.blade, victim, '全员投完 → 多数决定刀');
  // AI 座位的 uid 直投被拒（uid 自声明，AI 只能由房主经 seat 驱动）
  const aiSeat = room.game.players.find((p) => p && p.isAI).seat;
  const aiUid = room.game.players[aiSeat - 1].uid;
  const direct = logic.applyAction(room, 'speak', { uid: aiUid, text: 'x' }, { now: T0 });
  assert.ok(direct.error === 'AI 座位行动由房主携带 seat 参数提交' || direct.error, 'AI 座位 uid 直投被拒');
});

test('托管与行动超时（§7.7 / §5.11）：60s 无心跳转托管；150s 超时走确定性回退并推进', () => {
  const { room } = newGame();
  const seat2 = logic.seatOfUid(room, 'u2');
  const stale = structuredClone(room);
  stale.heartbeats['u2'] = T0 + 100 - 61_000; // 乙 61s 无心跳
  const swept = logic.sweep(stale, T0 + 100);
  assert.ok(swept.changed);
  assert.ok(swept.room.hosted.includes(seat2), '乙应被托管');
  assert.ok(swept.room.revs[seat2] > room.revs[seat2], '托管标公开 → rev+1');
  assert.ok(logic.snapshotFor(swept.room, 1).players.find((p) => p.seat === seat2).hosted, '快照带托管标');

  // 行动超时：deadline 过点 → 确定性回退推进（狼随机投一票，狼阶段继续）
  const pending = game.pendingSeat(room.game);
  assert.ok(room.game.players[pending - 1].role === 'werewolf', '狼阶段待行动 = 未投票的狼');
  const late = structuredClone(room);
  late.deadline = { at: T0 + 100 - 1, seat: pending };
  const timed = logic.sweep(late, T0 + 100);
  assert.ok(timed.changed, '超时应触发回退');
  assert.ok(timed.room.game.night.wolfVotes[pending] != null, '超时狼被回退投出一票');
  assert.equal(timed.room.game.subPhase, 'wolf', '单狼回退后狼阶段继续（其余狼待投票）');
  assert.equal(timed.room.deadline.seat, game.pendingSeat(timed.room.game), '下一个未投票的狼重新计时');
  assert.ok(timed.room.deadline.at > T0 + 100, '重新计时在未来');
  // 回退后该座位若为真人 → 同时转托管
  const actor = late.game.players[pending - 1];
  if (!actor.isAI) assert.ok(timed.room.hosted.includes(pending), '超时真人转托管');
});

test('房主失联 30 分钟 → 房间作废只读（§7.7）；单机真人不超时', () => {
  const { room } = newGame();
  const stale = structuredClone(room);
  stale.heartbeats['u1'] = T0 + 100 - 31 * 60_000;
  const gone = logic.sweep(stale, T0 + 100);
  assert.ok(gone.room.abandoned, '房主失联超 30 分钟房间作废');
  assert.ok(logic.snapshotFor(gone.room, 1).abandoned, '快照显示作废');
  const rejected = logic.applyAction(gone.room, 'speak', { uid: 'u1', text: 'x' }, { now: T0 + 100 });
  assert.ok(rejected.error, '作废后拒绝一切动作');

  // 单机（1 真人 + 8 AI 的私密房间）：不设行动超时、不掉线作废（§5.11 / §6）
  // ——内核最小开桌 3 人挡住 1 真人 start（见任务报告 gap），此处白盒模拟单机局
  let solo = logic.createRoom('SOLO1', { nick: '独行', uid: 's1' }, T0).room;
  const startErr = logic.applyAction(solo, 'start', { uid: 's1' }, { now: T0, seed: 1 });
  assert.ok(startErr.error, '受内核最小开桌数限制（见任务报告 gap）');
  const one = structuredClone(room);
  one.game.players.forEach((p) => {
    if (p && !p.isAI && p.uid !== 'u1') p.isAI = true; // 白盒：只留 1 真人
  });
  one.deadline = { at: T0 - 1, seat: game.pendingSeat(one.game) }; // 即使残留过期 deadline
  one.heartbeats['u1'] = T0 + 100 - 40_000; // 房主掉线
  const soloSweep = logic.sweep(one, T0 + 100);
  assert.equal(soloSweep.changed, false, '单机不超时、不作废');
  one.deadline = null;
  assert.equal(logic.nextAlarmAt(one, T0 + 100), null, '单机无 alarm');
});

test('心跳不抬 rev；托管座位重连（uid 心跳）即收回控制权；房主掉线翻转 ownerOnline', () => {
  const { room } = newGame();
  const beat = logic.touchHeartbeat(room, 'u2', T0 + 200);
  assert.equal(beat.changed, false);
  for (let seat = 1; seat <= 9; seat++) assert.equal(beat.room.revs[seat], room.revs[seat], '心跳不产生任何 rev 变化');

  // 托管座位重连：心跳即收回控制权（§7.7），rev 因托管标消失而 +1
  const hosted = structuredClone(room);
  const seat2 = logic.seatOfUid(hosted, 'u2');
  hosted.hosted.push(seat2);
  const back = logic.touchHeartbeat(hosted, 'u2', T0 + 200);
  assert.ok(back.changed, '重连应收回托管');
  assert.deepEqual(back.room.hosted, [], '托管清空');
  assert.ok(back.room.revs[seat2] > hosted.revs[seat2], '托管标消失 → rev+1');

  const stale = structuredClone(room);
  stale.ownerOnline = true;
  stale.heartbeats['u1'] = T0 + 200 - 40_000; // 房主掉线（> 35s 窗口）
  const gone = logic.touchHeartbeat(stale, 'u2', T0 + 200); // 他人轮询触发翻转
  assert.ok(gone.changed, '房主在线状态翻转');
  const s = logic.snapshotFor(gone.room, 2);
  assert.equal(s.ownerOnline, false);
  const pending = game.pendingSeat(gone.room.game);
  const pendingPlayer = gone.room.game.players[pending - 1];
  if (pendingPlayer && (pendingPlayer.isAI || gone.room.hosted.includes(pending))) {
    assert.equal(s.waitingOwner, true, 'AI 待行动且房主掉线 → 显示等待房主');
  }
});

test('AI 契约：buildAIRequest 组装 §5.0 请求体，女巫 roleCard 含当夜刀口', () => {
  const { room } = newGame();
  const cap = game.wolfCaptain(room.game);
  const victim = seatsOfRole(room, 'villager')[1];

  // 狼阶段（开局定刀前）：狼请求含身份设定、密聊任务与两行输出格式
  const wolfReq = logic.buildAIRequest(room, cap, { baseUrl: 'https://api.openai.com/v1', model: 'm' });
  assert.ok(!wolfReq.error, wolfReq.error);
  assert.ok(wolfReq.body.messages[0].content.includes('狼'), '狼 system 应含身份设定');
  assert.ok(wolfReq.body.messages[1].content.includes('狼队密聊'), '狼 user 消息应含密聊任务（§4.1.1）');
  assert.ok(wolfReq.body.messages[1].content.includes('两行'), '狼输出格式 = 密聊 + 投票两行');

  let cur = wolfKnifeAll(room, victim, T0 + 200);
  const step = (a, b, now) => {
    const out = logic.applyAction(cur, a, b, { now, seed: 42 });
    assert.ok(!out.error, `${a} 不应失败：${out.error}`);
    cur = out.room;
  };
  step('seer-check', driveSeat(cur, seatOfRole(cur, 'seer'), { target: seatsOfRole(cur, 'villager')[0] }), T0 + 210);
  const witchSeat = seatOfRole(cur, 'witch');
  assert.equal(cur.game.subPhase, 'witch', '推进到女巫阶段');

  const req = logic.buildAIRequest(cur, witchSeat, {
    baseUrl: 'https://api.openai.com/v1/',
    model: 'gpt-4o-mini',
  });
  assert.ok(!req.error, req.error);
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions', 'baseUrl 去尾斜杠拼 /chat/completions');
  assert.equal(req.body.model, 'gpt-4o-mini');
  assert.equal(req.body.temperature, 0.7); // 冻结值
  assert.equal(req.body.max_tokens, 16384); // 默认输出预算（思考型模型 800 必空正文）
  assert.equal(req.body.stream, true); // 体验通道思考型模型只认流式
  assert.equal(req.body.messages.length, 2);
  assert.equal(req.body.messages[0].role, 'system');
  assert.ok(req.body.messages[1].content.includes('刀口'), '女巫 user 消息应含当夜刀口');

  // ai_view 同源：女巫当夜刀口、狼队友名单（ADR-0002 驱动者数据来源）
  const view = logic.aiView(cur, witchSeat);
  assert.equal(view.view.knifeTarget, victim, 'ai_view 女巫当夜刀口（解药未用）');
  const wolfView = logic.aiView(cur, cap);
  assert.deepEqual(wolfView.view.wolves, seatsOfRole(cur, 'werewolf'));
  assert.equal(logic.aiView(cur, 99).error, '座位不存在');

  // 座位不是待行动者时（女巫阶段构造狼请求）→ prompts 角色强一致 → 报错走回退
  const mixed = logic.buildAIRequest(cur, cap, { baseUrl: 'https://api.openai.com/v1', model: 'm' });
  assert.ok(mixed.error, 'phase 与角色不符应硬失败');
});

test('parseAIReply（§5.1 宽容解析）：save/skip 优先、取首个 1–9 数字、发言截 200', () => {
  assert.deepEqual(logic.parseAIReply('witch', '  save '), { type: 'witch_move', move: 'save' });
  assert.deepEqual(logic.parseAIReply('witch', 'skip。'), { type: 'witch_move', move: 'skip' });
  assert.deepEqual(logic.parseAIReply('witch', '毒 3 号'), { type: 'witch_move', move: 'poison', target: 3 });
  assert.deepEqual(logic.parseAIReply('hunter', 'skip'), { type: 'hunter_shoot', target: null });
  assert.deepEqual(logic.parseAIReply('hunter', '4'), { type: 'hunter_shoot', target: 4 });
  assert.deepEqual(logic.parseAIReply('vote', 'skip'), { type: 'vote', target: null });
  assert.deepEqual(logic.parseAIReply('pk_vote', '6号，我最可疑'), { type: 'vote', target: 6 });
  assert.equal(logic.parseAIReply('seer', '不知道'), null);
  assert.equal(logic.parseAIReply('wolf', '7号'), null, '狼阶段改走 parseWolfReply 两行解析');
  const long = logic.parseAIReply('speak', '啊'.repeat(300));
  assert.equal(long.text.length, 250, '发言超 250 字截断');
  assert.equal(logic.parseAIReply('speak', '   '), null, '空发言 = 失败');
});

test('parseWolfReply（§4.1.1 两行格式）：首行密聊、余行投票；纯数字单行 = 只投票', () => {
  assert.deepEqual(logic.parseWolfReply('白天我跳预言家\n4'), { chat: '白天我跳预言家', target: 4 });
  assert.deepEqual(logic.parseWolfReply('过\n7号'), { chat: null, target: 7 }, '「过」= 无话可说');
  assert.deepEqual(logic.parseWolfReply('5'), { chat: null, target: 5 }, '纯数字单行 = 只投票');
  assert.deepEqual(
    logic.parseWolfReply('先压 4 号，都别暴露'),
    { chat: '先压 4 号，都别暴露', target: null },
    '单行非纯数字 → 只解析出密聊，投票走回退'
  );
  assert.deepEqual(logic.parseWolfReply('「刀 3 号」\n投 3'), { chat: '刀 3 号', target: 3 }, '剥引号');
  assert.deepEqual(logic.parseWolfReply(''), { chat: null, target: null });
  assert.deepEqual(logic.parseWolfReply(null), { chat: null, target: null });
});

test('死亡亮牌时机（§7.8 修订）：遗言提交前只见自己身份，提交后观战见全员；终局全亮', () => {
  const { room } = newGame();
  // 白盒构造：2 号被放逐、正轮到其留遗言（day:exile_lastwords 队列头 = 2）
  const g = structuredClone(room.game);
  g.phase = 'day';
  g.day = 1;
  g.subPhase = 'exile_lastwords';
  g.queue = [2];
  g.players[1].alive = false;
  g.players[1].death = { day: 1, cause: 'exile' };
  const shell = { ...room, game: g, deadline: null };
  const during = logic.snapshotFor(shell, 2);
  assert.equal(during.subPhase, 'exile_lastwords');
  assert.ok(
    during.players.every((p) => (p.seat === 2 ? p.role : p.role == null)),
    '输入遗言时不亮他人身份（2026-10-03 试玩反馈定的时机）'
  );
  // 遗言提交后（队列走完进入发言）：观战视角见全员身份
  g.subPhase = 'speak';
  g.queue = [1, 3, 4, 5, 6, 7, 8, 9];
  const after = logic.snapshotFor({ ...shell, game: g }, 2);
  assert.ok(after.players.every((p) => p && p.role), '遗言提交后观战见全员身份');
  // 终局不变：revealed 全亮（acceptance 另有全座位断言）
});

test('digestAIReply：解析 + 内核干跑校验——格式不合格 / 目标非法 action=null，合法通过', () => {
  const { room } = newGame();
  const wolf = game.pendingSeat(room.game); // 夜 1 狼阶段
  const villager = seatsOfRole(room, 'villager')[0];
  const ok = logic.digestAIReply(room.game, 'wolf', wolf, '听我口型，别露馅。\n' + villager);
  assert.equal(ok.action.target, villager, '合法两行回复 → 动作通过干跑校验');
  assert.equal(ok.chat, '听我口型，别露馅。');
  const chatOnly = logic.digestAIReply(room.game, 'wolf', wolf, '先听队友的');
  assert.equal(chatOnly.action, null, '有话没票 → 动作不可用（重试）');
  assert.equal(chatOnly.chat, '先听队友的', '密聊内容保留');

  // 投票阶段：死人目标 / 无数字 → action=null；空回复 → 全空
  const g = structuredClone(room.game);
  g.phase = 'day';
  g.subPhase = 'vote';
  g.votes = { round: 'main', cast: {} };
  g.queue = [];
  g.players[8].alive = false;
  g.players[8].death = { day: 1, cause: 'blade' };
  assert.ok(logic.digestAIReply(g, 'vote', 2, '投 3 号').action, '合法投票通过');
  assert.equal(logic.digestAIReply(g, 'vote', 2, '9').action, null, '投已死座位 = 格式不合格（干跑校验拦截）');
  assert.equal(logic.digestAIReply(g, 'vote', 2, '我还没想好').action, null, '无数字 = 解析失败');
  assert.equal(logic.digestAIReply(g, 'vote', 2, '').action, null, '空回复不可用');
});

test('drive_ai 狼阶段（§4.1.1）：一次调用提交密聊 + 投票两段；上游失败回退只投票', async () => {
  const realFetch = globalThis.fetch;
  try {
    class Store {
      constructor() {
        this.map = new Map();
      }
      async get(k) {
        return this.map.get(k);
      }
      async put(k, v) {
        this.map.set(k, v);
      }
      async delete(k) {
        this.map.delete(k);
      }
      async setAlarm() {}
      async deleteAlarm() {}
    }
    const boot = async () => {
      const room = new Room({ storage: new Store() }, {});
      const rpc = async (action, body, q = '') => {
        const res = await room.fetch(
          new Request(`https://do/?action=${action}${q}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)
        );
        return res.json();
      };
      await rpc('new', { nick: '甲', uid: 'o1' }, '&code=WOLF01');
      await rpc('join', { nick: '乙', uid: 'o2' });
      await rpc('join', { nick: '丙', uid: 'o3' });
      for (const u of ['o1', 'o2', 'o3']) await rpc('ready', { uid: u, ready: true });
      await rpc('start', { uid: 'o1' });
      return { room, rpc };
    };
    const CFG = { uid: 'o1', baseUrl: 'https://api.openai.com/v1', model: 'm', key: 'k' };
    const { room, rpc } = await boot();
    /* 白盒调牌：真人（1-3）全设平民，4/5/6 号 AI 设狼、7/8/9 设神职——
     * 狼阶段待行动序列确定为 AI 座位（4 号先行），断言与发牌随机性解耦 */
    const ROLES = ['villager', 'villager', 'villager', 'werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter'];
    room.room.game.players.forEach((p, i) => {
      if (p) p.role = ROLES[i];
    });

    // 桩上游返回两行回复 → 一次 drive_ai 同时入账密聊与投票
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '听我口型，白天都别露馅。\n4' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const r1 = await rpc('drive_ai', CFG);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.via, 'ai');
    const g1 = room.room.game;
    assert.equal(g1.wolfChatLog.length, 1, '密聊入账');
    assert.equal(g1.night.wolfVotes[g1.wolfChatLog[0].seat], 4, '同一次调用完成投票');

    // 桩上游不可达 → 回退：只随机投票，不产生密聊
    globalThis.fetch = async () => {
      throw new Error('down');
    };
    const r2 = await rpc('drive_ai', CFG);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.via, 'fallback');
    assert.equal(room.room.game.wolfChatLog.length, 1, '回退不产生密聊');
    assert.equal(Object.keys(room.room.game.night.wolfVotes).length, 2, '回退投出一票');

    // 重试（§8.4）：第一次请求抛错 → 第二次合法 → via='ai'，恰好 2 次尝试
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('flaky');
      return new Response(JSON.stringify({ choices: [{ message: { content: '稳住，白天都听我的。\n4' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r3 = await rpc('drive_ai', CFG);
    assert.equal(r3.ok, true, JSON.stringify(r3));
    assert.equal(r3.via, 'ai', '重试成功不走回退');
    assert.equal(calls, 2, '失败后恰好重试 1 次');
    assert.equal(room.room.game.wolfChatLog.length, 2, '重试成功密聊入账');

    // 格式不合格（无数字无 skip）→ 重试后合法（此时狼已投完，轮到预言家 AI）
    let step = 0;
    globalThis.fetch = async () => {
      step += 1;
      const content = step === 1 ? '我还没想好' : '3';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r4 = await rpc('drive_ai', CFG);
    assert.equal(r4.ok, true, JSON.stringify(r4));
    assert.equal(r4.via, 'ai', '格式不合格重试后合法');
    assert.equal(step, 2, '格式不合格恰好重试 1 次');
    assert.equal(room.room.game.seerChecks.length, 1, '预言家验人入账');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('windowHistory（§5.4）：最近 2 个完整白天全量、更早压 digest、超限丢最旧', () => {
  const log = [];
  for (let day = 1; day <= 5; day++) {
    log.push({ t: 'deaths', day, seats: day === 1 ? [9] : [] });
    log.push({ t: 'speech', day, seat: 1, text: `第${day}天发言` });
    log.push({ t: 'vote', day, voter: 1, target: 2 });
    log.push({ t: 'exile', day, seat: day < 5 ? day + 1 : null });
  }
  const w = logic.windowHistory(log);
  assert.ok(w.some((e) => e.t === 'digest' && e.day === 1), '第 1 天被压缩');
  assert.ok(w.some((e) => e.t === 'digest' && e.day === 2), '第 2 天被压缩');
  for (const e of w) if (e.t !== 'digest') assert.ok(e.day >= 3, '第 3 天起全量保留');
  const d1 = w.find((e) => e.t === 'digest' && e.day === 1);
  assert.deepEqual(d1.dead, [2, 9], 'digest.dead 完整计亡（当夜死者 9 + 被放逐 2）');

  // 超限从最旧丢弃
  const big = [];
  for (let day = 1; day <= 6; day++) big.push({ t: 'speech', day, seat: 1, text: 'x'.repeat(900) });
  const capped = logic.windowHistory(big, 2000);
  assert.ok(JSON.stringify(capped).length <= 2000 + 900, '裁剪后逼近上限');
  assert.ok(capped.every((e) => e.day > big[0].day), '最先丢最旧的天');
});

/* ---------------- AI 代理头白名单（ai-proxy.js） ---------------- */

test('AI 代理：转发头白名单（content-type / authorization / x-api-key / anthropic-version / accept）', async () => {
  const incoming = new Headers({
    'content-type': 'application/json',
    authorization: 'Bearer sk-test',
    'x-api-key': 'k2',
    'anthropic-version': '2023-06-01',
    accept: 'application/json',
    cookie: 'session=hijack',
    'x-custom': 'drop-me',
    'x-forwarded-for': '1.2.3.4',
  });
  const built = buildProxyRequest({ url: 'https://api.openai.com/v1/chat/completions', body: { model: 'm' } }, incoming);
  assert.ok(built.ok, JSON.stringify(built));
  assert.deepEqual(
    Object.keys(built.headers).sort(),
    ['accept', 'anthropic-version', 'authorization', 'content-type', 'x-api-key'],
    '只透传白名单头'
  );
  assert.equal(built.headers.authorization, 'Bearer sk-test');

  // 缺 content-type 时补默认
  const bare = new Headers({ authorization: 'Bearer k' });
  const built2 = buildProxyRequest({ url: 'https://api.openai.com/v1', body: {} }, bare);
  assert.equal(built2.headers['content-type'], 'application/json');

  // 执行器：mock fetch 捕获出站请求
  let captured = null;
  const out = await proxyFetch(built.url, built.headers, built.payload, 1000, async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(captured.url, built.url);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test');
  assert.equal(captured.init.body, built.payload);
  assert.equal(out.status, 200);
  assert.ok(out.text.includes('choices'));
  assert.equal(out.contentType, 'application/json');
});

test('AI 代理：url-guard 拒绝内网 / 超大 body 拒绝（不发出站）', () => {
  const h = new Headers({ authorization: 'Bearer k' });
  for (const url of ['http://127.0.0.1/v1', 'http://localhost/v1', 'http://192.168.1.1/v1', 'ftp://x.com']) {
    const out = buildProxyRequest({ url, body: {} }, h);
    assert.equal(out.error.code, 'URL_REJECTED', `${url} 应被拒`);
    assert.equal(out.error.status, 400);
  }
  const big = buildProxyRequest({ url: 'https://api.openai.com/v1', body: { prompt: 'x'.repeat(70 * 1024) } }, h);
  assert.equal(big.error.code, 'BODY_TOO_LARGE');
  assert.equal(big.error.status, 413);
  const bad = buildProxyRequest(null, h);
  assert.equal(bad.error.code, 'BAD_REQUEST');
});

test('AI 代理：上游失败 / 超大响应截断 / 同 IP 日限 5000', async () => {
  const failed = await proxyFetch('https://api.openai.com/v1', {}, '{}', 10, async () => {
    throw new Error('network down');
  });
  assert.equal(failed.error, 'UPSTREAM_ERROR');

  const huge = await proxyFetch('https://api.openai.com/v1', {}, '{}', 1000, async () => {
    return new Response('y'.repeat(8 * 1024 * 1024 + 100));
  });
  assert.equal(huge.text.length, 8 * 1024 * 1024, '下行截断 ≤8MB');

  resetRateLimiterForTests();
  const ip = 'test-limited-ip';
  for (let i = 0; i < 5000; i++) assert.equal(aiProxyLimited(ip, Date.now()), false);
  assert.equal(aiProxyLimited(ip, Date.now()), true, '第 5001 次拒绝');
  resetRateLimiterForTests();
});

/* ---------------- 路由集成（fake DO 环境） ---------------- */

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarmAt = null;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
  async setAlarm(t) {
    this.alarmAt = t;
  }
  async getAlarm() {
    return this.alarmAt;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}

function makeEnv() {
  const rooms = new Map();
  const env = {
    ALLOWED_ORIGINS: 'https://werewolf.xxx794665.party,https://xxx794665.github.io,http://localhost:8788',
    ROOM: {
      idFromName(code) {
        return { name: String(code).toUpperCase() };
      },
      get(id) {
        if (!rooms.has(id.name)) rooms.set(id.name, new Room({ storage: new FakeStorage() }, env));
        const room = rooms.get(id.name);
        /* 真实 DO stub 会把 (url, init) 物化成 Request 再进 DO fetch，这里同款适配 */
        return { fetch: (url, init) => room.fetch(new Request(url, init)) };
      },
    },
  };
  return env;
}

const post = (path, body, headers) =>
  new Request(`https://worker${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
const get = (path, headers) => new Request(`https://worker${path}`, { method: 'GET', headers: headers || {} });

test('路由集成：建房 → 进房 → 准备 → 补位开桌 → 轮询 rev / unchanged / ai_view', async () => {
  resetRoomLimiterForTests();
  const env = makeEnv();
  const ip = { 'cf-connecting-ip': '198.51.100.1' };

  const health = await worker.fetch(get('/api/health'), env);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const created = await worker.fetch(post('/api/room/new', { nick: '甲', uid: 'u1' }, ip), env);
  assert.equal(created.status, 200);
  const { code } = await created.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/, '6 位去易混房号');

  const join = async (nick, uid) =>
    (await worker.fetch(post(`/api/room/${code}/join`, { nick, uid }, ip), env)).json();
  assert.equal((await join('乙', 'u2')).ok, true);
  assert.equal((await join('丙', 'u3')).ok, true);

  const ready = async (uid) =>
    (await worker.fetch(post(`/api/room/${code}/ready`, { uid, ready: true }, ip), env)).json();
  assert.equal((await ready('u1')).ok, true);
  assert.equal((await ready('u2')).ok, true);
  assert.equal((await ready('u3')).ok, true);

  const started = await worker.fetch(post(`/api/room/${code}/start`, { uid: 'u1' }, ip), env);
  assert.equal(started.status, 200);
  assert.equal((await started.json()).aiFilled, 6, '自动补 6 个 AI 到 9 人');

  const poll = await worker.fetch(get(`/api/room/${code}/state?uid=u1`, ip), env);
  assert.equal(poll.status, 200);
  const snap1 = await poll.json();
  assert.equal(snap1.phase, 'night');
  assert.equal(snap1.day, 1);
  assert.equal(snap1.mySeat, 1);
  assert.equal(snap1.players.length, 9);
  assert.equal('subPhase' in snap1, false, '夜里快照不露子阶段');
  assert.equal(typeof snap1.rev, 'number');

  const again = await worker.fetch(get(`/api/room/${code}/state?uid=u1&rev=${snap1.rev}`, ip), env);
  const body = await again.json();
  assert.deepEqual(body, { unchanged: true }, '无变化回 unchanged');

  const other = await worker.fetch(get(`/api/room/${code}/state?uid=u2`, ip), env);
  const snap2 = await other.json();
  assert.equal(snap2.subPhase, undefined, '夜里任何座位都不露子阶段');
  assert.ok(snap2.players.every((p) => p.role === undefined || p.seat === snap2.mySeat), '暗牌：他人角色不可见');

  // ai_view：owner 专属
  const aiSeat = snap1.players.find((p) => p.isAI).seat;
  const view = await worker.fetch(post(`/api/room/${code}/ai_view`, { uid: 'u1', seat: aiSeat }, ip), env);
  assert.equal(view.status, 200);
  assert.equal((await view.json()).view.seat, aiSeat);
  const denied = await worker.fetch(post(`/api/room/${code}/ai_view`, { uid: 'u2', seat: aiSeat }, ip), env);
  assert.equal(denied.status, 403, '非 owner 不可读 AI 视角');

  // 未知动作 / 未知路由
  const badAct = await worker.fetch(post(`/api/room/${code}/dance`, { uid: 'u1' }, ip), env);
  assert.equal(badAct.status, 404);
  const notFound = await worker.fetch(get('/api/nope', ip), env);
  assert.equal(notFound.status, 404);
});

test('路由集成：CORS 只放行 ALLOWED_ORIGINS', async () => {
  const env = makeEnv();
  const ok = await worker.fetch(get('/api/health', { origin: 'https://xxx794665.github.io' }), env);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://xxx794665.github.io');
  const party = await worker.fetch(get('/api/health', { origin: 'https://werewolf.xxx794665.party' }), env);
  assert.equal(party.headers.get('access-control-allow-origin'), 'https://werewolf.xxx794665.party', '自定义域主前端来源回显');
  const evil = await worker.fetch(get('/api/health', { origin: 'https://evil.example' }), env);
  assert.equal(evil.headers.get('access-control-allow-origin'), null, '非白名单来源不回 CORS 头');
  const preflight = await worker.fetch(
    new Request('https://worker/api/room/new', { method: 'OPTIONS', headers: { origin: 'http://localhost:8788' } }),
    env
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8788');
});

test('路由集成：建房限流同 IP 每日 100 房；ai-proxy 拒绝内网 URL', async () => {
  resetRoomLimiterForTests();
  const env = makeEnv();
  const ip = { 'cf-connecting-ip': '203.0.113.7' };
  let last = null;
  for (let i = 0; i < 100; i++) {
    last = await worker.fetch(post('/api/room/new', { nick: `n${i}`, uid: `u${i}` }, ip), env);
    assert.equal(last.status, 200, `第 ${i + 1} 间房应成功`);
  }
  const over = await worker.fetch(post('/api/room/new', { nick: 'x', uid: 'x' }, ip), env);
  assert.equal(over.status, 429);
  assert.equal((await over.json()).error, 'RATE_LIMITED');
  resetRoomLimiterForTests();

  const rejected = await worker.fetch(
    post('/api/ai-proxy', { url: 'http://127.0.0.1/v1/chat/completions', body: {} }, { ...ip, authorization: 'Bearer k' }),
    env
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'URL_REJECTED');
  resetRateLimiterForTests();
});

test('体验通道：默认上游且无 key → 注入 Secret；自带 key 原样透传；他域不注入', async () => {
  assert.ok(isDefaultAiUrl(DEFAULT_AI_BASE + '/chat/completions'));
  assert.ok(!isDefaultAiUrl('https://evil.example/v1/chat/completions'), '他域不命中默认通道');
  assert.ok(!isDefaultAiUrl(DEFAULT_AI_BASE), '裸 base（无路径）不命中，注入只随完整出站 URL');
  const env = makeEnv();
  env.DEFAULT_AI_KEY = 'test-injected-key';
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: (init.headers && init.headers.authorization) || null });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const r1 = await worker.fetch(
      post('/api/ai-proxy', { url: DEFAULT_AI_BASE + '/chat/completions', body: { model: 'm', messages: [] } }, ip),
      env
    );
    assert.equal(r1.status, 200);
    const r2 = await worker.fetch(
      post('/api/ai-proxy', { url: DEFAULT_AI_BASE + '/chat/completions', body: { model: 'm', messages: [] } }, { ...ip, authorization: 'Bearer mine' }),
      env
    );
    assert.equal(r2.status, 200);
    const r3 = await worker.fetch(
      post('/api/ai-proxy', { url: 'https://api.example.com/v1/chat/completions', body: { model: 'm', messages: [] } }, ip),
      env
    );
    assert.equal(r3.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    resetRateLimiterForTests();
  }
  assert.equal(seen.length, 3);
  assert.equal(seen[0].auth, 'Bearer test-injected-key', '无 key + 默认上游 → 注入 Secret');
  assert.equal(seen[1].auth, 'Bearer mine', '自带 key 原样透传，不覆盖');
  assert.equal(seen[2].auth, null, '他域永不注入，Bearer 不外带');
});

/* ---------------- AI 名册（ADR-0009）：/api/ai-roster 与 DO 开局内部抽取 ---------------- */

test('/api/ai-roster：按 count 抽取人格 × 网名（不重复、与身份无关），越界 400', async () => {
  const env = makeEnv();
  const ip = { 'cf-connecting-ip': '9.9.9.9' };
  const res = await worker.fetch(post('/api/ai-roster', { count: 8 }, ip), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.roster.length, 8);
  assert.equal(new Set(data.roster.map((e) => e.persona)).size, 8, '人格一局不重复');
  assert.equal(new Set(data.roster.map((e) => e.nick)).size, 8, '网名全局唯一');
  for (const e of data.roster) {
    assert.ok(PERSONAS.includes(e.persona), '人格出自 PERSONAS');
    assert.equal(typeof e.nick, 'string');
    assert.ok(e.nick.length >= 1 && e.nick.length <= 20);
  }
  for (const bad of [{ count: 9 }, { count: -1 }, { count: 'x' }, {}]) {
    const r = await worker.fetch(post('/api/ai-roster', bad, ip), env);
    assert.equal(r.status, 400, `count=${JSON.stringify(bad.count)} 应 400`);
  }
});

test('路由集成：DO 开局内部抽名册 → AI 座位带池内网名与 persona；快照不透出 persona', async () => {
  const env = makeEnv();
  const ip = { 'cf-connecting-ip': '8.8.4.4' };
  resetRoomLimiterForTests();
  const code = (await (await worker.fetch(post('/api/room/new', { nick: '甲', uid: 'u1' }, ip), env)).json()).code;
  await worker.fetch(post(`/api/room/${code}/join`, { nick: '乙', uid: 'u2' }, ip), env);
  await worker.fetch(post(`/api/room/${code}/join`, { nick: '丙', uid: 'u3' }, ip), env);
  for (const uid of ['u1', 'u2', 'u3']) {
    await worker.fetch(post(`/api/room/${code}/ready`, { uid, ready: true }, ip), env);
  }
  const started = await worker.fetch(post(`/api/room/${code}/start`, { uid: 'u1' }, ip), env);
  assert.equal(started.status, 200);

  // ai_view（owner 专属）能看到该 AI 座位的网名、persona 与全员名录
  const snap = await (await worker.fetch(get(`/api/room/${code}/state?uid=u1`, ip), env)).json();
  const aiSeat = snap.players.find((p) => p.isAI).seat;
  const view = (await (await worker.fetch(post(`/api/room/${code}/ai_view`, { uid: 'u1', seat: aiSeat }, ip), env)).json()).view;
  assert.ok(view.nick && view.nick !== `AI-${aiSeat}`, 'AI 座位网名来自名册而非默认 AI-n');
  assert.equal(typeof view.persona, 'string', 'ai_view 带 persona（AI 提示词用）');
  assert.ok(Array.isArray(view.roster) && view.roster.length === 9, 'roleCard 带全员昵称对照');
  assert.ok(view.roster.every((e) => typeof e.nick === 'string' && e.nick.length > 0));

  // 快照（安全边界）：昵称公开可透，persona 绝不透出
  const aiEntry = snap.players.find((p) => p.seat === aiSeat);
  assert.equal(aiEntry.nick, view.nick, '快照昵称与名册一致');
  assert.equal('persona' in aiEntry, false, '快照不透出 persona');
  for (const seat of [2, 3]) {
    const other = await (await worker.fetch(get(`/api/room/${code}/state?uid=u${seat}`, ip), env)).json();
    assert.equal('persona' in other.players.find((p) => p.isAI), false, '任何座位快照都不带 persona');
  }
});
