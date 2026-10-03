/* ============================================================
 * test/acceptance.test.mjs —— 验收测试（node --test 自动发现）
 * ------------------------------------------------------------
 * 覆盖（对应验收任务书）：
 *   1. 单机完整对局：固定种子发牌 → 桩 AI（本地函数替代网络，stub fetch
 *      截获 /api/ai-proxy 信封）走完夜晚 / 白天 / 投票 → revealed 胜负判定；
 *      并逐次断言 buildMessages 组装的每个 AI 请求只含公开历史 + 该 AI
 *      自己的身份卡，绝无其他隐藏信息（docs/ai-prompts.md §1 铁律）。
 *   2. 联机完整对局：建房 → 进房 → 准备 → 房主 start 自动补 AI 至 9 人 →
 *      走完夜晚 / 白天 / 投票 → 结束（驱动 worker/src/room-logic.js 纯逻辑层）。
 *   3. url-guard 验收条件再覆盖（features.md §10 基线全量）。
 *   4. 轮询快照 rev 游标（经 worker 路由 + fake DO）：无变化回 unchanged、
 *      有动作递增。
 * 全量 node --test 由工作流统一执行；本文件可单跑：
 *   node --test test/acceptance.test.mjs
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as game from '../shared/game.js';
import { buildMessages } from '../shared/prompts.js';
import * as ai from '../js/ai.js';
import * as logic from '../worker/src/room-logic.js';
import { checkUrl } from '../worker/src/url-guard.js';
import worker, { resetRoomLimiterForTests } from '../worker/src/index.js';
import { Room } from '../worker/src/room.js';

const ROLE_NAME = { wolf: '狼人', villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人' };

/* ---------- 公开历史 schema（ai-prompts.md §1.3）：只允许这些事件与字段 ---------- */

const HISTORY_KEYS = {
  deaths: ['day', 'seats', 't'],
  speech: ['day', 'seat', 't', 'text'],
  lastwords: ['day', 'seat', 't', 'text'],
  pk_speak: ['day', 'seat', 't', 'text'],
  tie: ['day', 'seats', 't'],
  vote: ['day', 't', 'target', 'voter'],
  exile: ['day', 'seat', 't'],
  hunter: ['day', 'seat', 't', 'target'],
  digest: ['day', 'dead', 't', 'text'],
};

function assertPublicHistory(ev, where) {
  assert.ok(HISTORY_KEYS[ev.t], `${where}: 未知事件类型 ${ev.t}`);
  assert.deepEqual(
    Object.keys(ev).sort(),
    HISTORY_KEYS[ev.t],
    `${where}: ${ev.t} 事件携带 schema 外字段（可能夹带隐藏信息）`
  );
}

/* ---------- 铁律断言：一次 AI 请求 = 公开历史 + 该座位身份卡，仅此而已 ---------- */

function assertNoLeak(req) {
  const { seat, phase, card, messages, history, state } = req;
  const label = `seat=${seat} role=${card.role} phase=${phase}`;

  // 消息形状：恒为 system + user 两条（ai-prompts.md §0）
  assert.equal(messages.length, 2, `${label}: messages 必须恒为两条`);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  const combined = messages[0].content + '\n' + messages[1].content;

  // 结构纯度：messages 是 (公开历史, 本人身份卡, phase) 的纯函数——重算必须逐字节一致，
  // 证明驱动链路没有第三条数据通道（ai-prompts.md §1.4 模块层）
  assert.deepEqual(buildMessages(history, card, phase), messages, `${label}: 请求体不是三输入的纯函数`);

  // 历史只含公开事件 schema（§1.3），死因 / 他人身份等字段不存在
  history.forEach((ev, i) => assertPublicHistory(ev, `${label} history[${i}]`));

  // 身份行：只有本人（“你是 N 号，X（阵营）”）
  assert.ok(
    messages[0].content.includes(`你是 ${seat} 号，${ROLE_NAME[card.role]}（`),
    `${label}: system 必须含本人身份行`
  );
  for (let k = 1; k <= 9; k++) {
    if (k !== seat) assert.ok(!combined.includes(`你是 ${k} 号`), `${label}: 出现 ${k} 号的身份行，疑泄密`);
  }

  // roleCard 角色白名单 + 私有信息与真实内核状态一致（合法私有信息必须是真的）
  const keys = Object.keys(card).sort();
  if (card.role === 'wolf') {
    // §4.1.1：狼阶段额外带密聊 / 投票 / 队长（均属狼座合法私有视角）
    assert.ok(
      keys.every((k) => ['role', 'seat', 'wolves', 'wolfChat', 'wolfVotes', 'captain'].includes(k)),
      `${label}: 狼身份卡字段越界：${keys.join(',')}`
    );
    const actual = state.players.filter((p) => p && p.role === 'werewolf').map((p) => p.seat);
    assert.deepEqual(card.wolves, actual, `${label}: 狼队友名单必须等于真实狼座位`);
    if ('wolfChat' in card) {
      assert.equal(phase, 'wolf', `${label}: 密聊只允许出现在狼阶段身份卡`);
      assert.deepEqual(
        card.wolfChat,
        (state.night && state.night.wolfChat) || [],
        `${label}: 密聊记录必须等于真实频道内容`
      );
      assert.deepEqual(
        card.wolfVotes,
        (state.night && state.night.wolfVotes) || {},
        `${label}: 狼票必须等于真实投票`
      );
      assert.equal(card.captain, game.wolfCaptain(state), `${label}: 队长必须是内核推导值`);
    } else {
      assert.notEqual(phase, 'wolf', `${label}: 狼阶段身份卡必须携带密聊频道`);
    }
  } else if (card.role === 'seer') {
    assert.deepEqual(keys, ['checks', 'role', 'seat'], `${label}: 预言家身份卡字段越界`);
    for (const c of card.checks) {
      const actualRole = state.players[c.seat - 1].role;
      assert.equal(c.result, actualRole === 'werewolf' ? 'wolf' : 'good', `${label}: 验人结果必须与真实身份一致`);
    }
  } else if (card.role === 'witch') {
    assert.ok(
      keys.every((k) => ['seat', 'role', 'antidote', 'poison', 'knifeTarget'].includes(k)),
      `${label}: 女巫身份卡字段越界`
    );
    if ('knifeTarget' in card) {
      assert.equal(phase, 'witch', `${label}: 刀口只允许出现在女巫行动夜`);
      assert.equal(card.antidote, true, `${label}: 解药已用不得再看刀口（§4.1.3）`);
      assert.equal(card.knifeTarget, state.night && state.night.blade, `${label}: 刀口必须是当夜真实刀口`);
    }
  } else {
    assert.deepEqual(keys, ['role', 'seat'], `${label}: 平民 / 猎人身份卡只允许座位与角色`);
  }

  // 跨角色私密信息探针：他人可见内容里绝不出现别的角色的私有渲染
  if (card.role !== 'wolf') {
    assert.ok(!combined.includes('全体狼座位') && !combined.includes('存活队友'), `${label}: 非狼不得见狼队名单`);
    assert.ok(!combined.includes('狼队密聊记录'), `${label}: 非狼不得见狼队密聊（§4.1.1）`);
  }
  if (card.role !== 'seer') assert.ok(!combined.includes('查验记录'), `${label}: 非预言家不得见验史`);
  if (card.role !== 'witch') assert.ok(!combined.includes('你的解药'), `${label}: 非女巫不得见用药状态`);
  if (!(phase === 'witch' && card.role === 'witch')) {
    assert.ok(!combined.includes('当夜刀口是'), `${label}: 当夜刀口只给行动夜且解药未用的女巫`);
  }
}

/* ============================================================
 * 1. 单机完整对局（固定种子 + 桩 AI 替代网络）
 * ============================================================ */

/* node 无 localStorage：先补全局 shim，BYO 配置才进得了 ai.loadConfig() */
const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => memStore.set(k, String(v)),
  removeItem: (k) => memStore.delete(k),
};

test('单机：固定种子发牌可复现（同一 seed 两次发牌结果一致）', () => {
  const deal = () => {
    let s = game.advance(game.createInitialState(), { type: 'join', nick: '独行', uid: 'u-solo' }).state;
    s = game.advance(s, { type: 'ready', seat: 1, ready: true }).state;
    return game.advance(s, { type: 'start', seed: 20261003, solo: true }).state.players.map((p) => p.role);
  };
  assert.deepEqual(deal(), deal(), '同一 seed 发牌必须可复现');
});

test('单机完整对局：桩 AI 走完夜晚/白天/投票至 revealed；每次 AI 请求只含历史+本人身份卡', async () => {
  /* BYO 配置（localStorage，按请求透传） */
  ai.saveConfig({ baseUrl: 'https://stub.example.com/v1', key: 'test-key', model: 'stub-model' });

  /* 桩 AI = 本地函数替代网络：截获 /api/ai-proxy 信封，按当前任务返回合法回复。
   * nextReply 由驱动循环在每次 decideFor 前按 (座位, phase) 放好。 */
  const captured = []; // { url, init, envelope }
  let nextReply = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init, envelope: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: nextReply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    let s = game.advance(game.createInitialState(), { type: 'join', nick: '独行', uid: 'u-solo' }).state;
    s = game.advance(s, { type: 'ready', seat: 1, ready: true }).state;
    const started = game.advance(s, { type: 'start', seed: 20261003, solo: true });
    assert.equal(started.error, null, `solo 开局不应失败：${started.error}`);
    s = started.state;
    assert.equal(s.players.filter(Boolean).length, 9, '原子补 AI 到 9 人');
    assert.equal(s.players.filter((p) => p && p.isAI).length, 8, '1 真人 + 8 AI');
    assert.equal(s.phase, 'night');
    assert.equal(s.subPhase, 'wolf');

    const log = [];
    const requests = []; // 每次 AI 请求的现场：{ seat, phase, card, messages, history, state }
    const phasesSeen = new Set();
    const alive = (st) => st.players.filter((p) => p && p.alive).map((p) => p.seat);

    /* 桩 AI 的回复（站在驱动者位置选合法目标；请求内容本身不含这些） */
    const stubReply = (st, seat, phase) => {
      const others = alive(st).filter((x) => x !== seat);
      switch (phase) {
        case 'speak':
          return `我是${seat}号，目前信息不多，先听听后面的人怎么聊，再决定票往哪走。`;
        case 'lastwords':
          return '我先走了，大家按票型和发言好好盘，别被带节奏。';
        case 'pk_speak':
          return '我确实是好人，台上另一位更值得出，大家想清楚再投。';
        case 'wolf':
          return `今晚刀 ${alive(st)[0]} 号，白天我来带节奏，你们口型跟我对齐。\n${alive(st)[0]}`;
        case 'seer':
          return String(others[0]);
        case 'witch':
          return 'skip';
        case 'hunter':
          return 'skip';
        case 'vote':
          return String(others[0]);
        case 'pk_vote': {
          const t = (st.pkCandidates || []).find((x) => x !== seat);
          return t == null ? 'skip' : String(t);
        }
        default:
          throw new Error(`桩 AI 未知阶段 ${phase}`);
      }
    };

    /* 真人座位（1 号）由测试脚本代操作，口径与桩 AI 相同（狼阶段两行：密聊 + 投票） */
    const humanAction = (st, seat, phase) => {
      const text = stubReply(st, seat, phase);
      if (phase === 'wolf') {
        const w = ai.parseWolfReply(text);
        return {
          chat: w.chat,
          action: w.target != null ? { type: 'wolf_target', target: w.target, seat } : null,
        };
      }
      const parsed = ai.parseReply(phase, text);
      assert.ok(parsed, `真人动作解析失败：${phase} / ${text}`);
      return { chat: null, action: { ...parsed, seat } };
    };

    let guard = 0;
    while (s.phase !== 'revealed' && guard++ < 1000) {
      const seat = game.pendingSeat(s);
      assert.notEqual(seat, null, `对局中应有待行动座位（day=${s.day} ${s.subPhase}）`);
      const phase = ai.phaseOf(s);
      assert.ok(phase, `待行动时必须有 AI 任务阶段（${s.phase}:${s.subPhase}）`);
      phasesSeen.add(phase);

      let chat = null;
      let action = null;
      if (seat === 1) {
        ({ chat, action } = humanAction(s, seat, phase));
      } else {
        /* 生产同款链路（ai.decideFor）：roleCardOf → windowHistory → buildMessages →
         * /api/ai-proxy（被桩截获）→ parseReply；捕获现场供铁律断言。 */
        const historyAtCall = ai.windowHistory(log).slice();
        const cardAtCall = ai.roleCardOf(s, seat);
        const stateAtCall = s;
        const capturedBefore = captured.length;
        nextReply = stubReply(s, seat, phase);
        const d = await ai.decideFor(s, log, seat);
        /* 必须恰好发出一次请求，且走 Worker 代理而非直连上游 */
        assert.equal(captured.length, capturedBefore + 1, `seat=${seat} phase=${phase} 应发出一次 AI 请求`);
        const call = captured[captured.length - 1];
        assert.ok(call.url.endsWith('/api/ai-proxy'), '浏览器必须经 Worker /api/ai-proxy 转发（不直连上游）');
        assert.equal(call.init.method, 'POST');
        assert.equal(call.init.headers.authorization, 'Bearer test-key', 'Key 按请求透传');
        assert.equal(call.envelope.url, 'https://stub.example.com/v1/chat/completions', '信封 url = baseUrl + /chat/completions');
        assert.equal(call.envelope.body.model, 'stub-model');
        assert.equal(call.envelope.body.temperature, 0.7, '冻结值 temperature=0.7');
        assert.equal(call.envelope.body.max_tokens, 800, '冻结值 max_tokens=800');
        requests.push({
          seat,
          phase,
          card: cardAtCall,
          messages: call.envelope.body.messages,
          history: historyAtCall,
          state: stateAtCall,
        });
        chat = d.chat;
        action = d.action ? { ...d.action, seat } : null;
      }

      if (chat) {
        /* §4.1.1 狼队密聊：先入频道（不产生公开事件），再投票 */
        const c = game.advance(s, { type: 'wolf_chat', seat, text: chat });
        assert.equal(c.error, null, `狼队密聊提交失败：${c.error}`);
        s = c.state;
      }
      let r = action ? game.advance(s, action) : { error: 'ai-failed' };
      if (r.error) {
        const fb = game.applyFallback(s, seat); // §8.4 确定性回退，不打断游戏
        assert.equal(fb.error, null, `回退不应失败（seat=${seat} ${phase}）：${fb.error}`);
        r = fb;
      }
      s = r.state;
      log.push(...ai.toHistory(r.events));
    }

    assert.equal(s.phase, 'revealed', '整局必须收敛（狼不可空刀 §5.10）');
    assert.ok(s.winner === 'good' || s.winner === 'wolf', `必须有胜负判定，实际 ${s.winner}`);
    assert.ok(typeof s.reason === 'string' && s.reason.length > 0, '必须有胜负原因');
    assert.ok(log.length > 0, '公开事件账本非空');
    assert.ok(phasesSeen.has('wolf') && phasesSeen.has('speak') && phasesSeen.has('vote'), '必须走完夜晚 / 白天发言 / 投票');
    assert.ok(requests.length > 0, '至少发生一次 AI 请求');

    /* 铁律：逐次核对捕获到的每一个真实 AI 请求 */
    for (const req of requests) assertNoLeak(req);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ============================================================
 * 2. 联机完整对局（驱动 worker/src/room-logic.js 纯逻辑层）
 * ============================================================ */

const T0 = 1_000_000;

test('联机完整对局：建房→进房→准备→补位开局→走完整流程→结束（房间纯逻辑层）', () => {
  let room = logic.createRoom('TEST99', { nick: '甲', uid: 'u1' }, T0).room;
  assert.equal(room.ownerUid, 'u1');
  assert.equal(room.game.phase, 'lobby');

  let now = T0;
  const act = (action, body) => {
    now += 500;
    const out = logic.applyAction(room, action, body, { now, seed: 99 });
    return out;
  };
  const must = (action, body) => {
    const out = act(action, body);
    assert.equal(out.error, undefined, `${action} 不应失败：${out.error}`);
    room = out.room;
    return out;
  };

  /* 进房 ×2（3 真人）+ 准备 */
  must('join', { nick: '乙', uid: 'u2' });
  must('join', { nick: '丙', uid: 'u3' });
  must('ready', { uid: 'u1', ready: true });
  must('ready', { uid: 'u2', ready: true });

  /* 未全员准备 → start 重校验拒绝（§7.4） */
  const early = act('start', { uid: 'u1' });
  assert.equal(early.error, '仍有真人未准备');

  /* 非房主 start → 拒 */
  const notOwner = act('start', { uid: 'u2' });
  assert.equal(notOwner.error, '仅房主可以开始游戏');

  must('ready', { uid: 'u3', ready: true });

  /* 房主 start：人数不足 → 自动补 AI 至 9 人（唯一板子固定 9，§3 / §7.4），原子进 night_1 */
  const started = must('start', { uid: 'u1' });
  assert.equal(started.data.aiFilled, 6, '3 真人 → 补 6 个 AI');
  assert.equal(room.game.players.filter(Boolean).length, 9);
  assert.deepEqual(
    room.game.players.filter((p) => p.isAI).map((p) => p.nick),
    ['AI-1', 'AI-2', 'AI-3', 'AI-4', 'AI-5', 'AI-6'],
    'AI 座位按补位顺序命名（§7.5）'
  );
  assert.equal(room.game.phase, 'night');
  assert.equal(room.game.day, 1);
  assert.equal(room.game.subPhase, 'wolf');

  /* 完整流程：房主驱动 AI / 托管座位，真人座位本人提交（§7.6 驱动模型） */
  const phasesSeen = new Set();
  let guard = 0;
  while (room.game.phase !== 'revealed' && guard++ < 2000) {
    const g = room.game;
    const seat = game.pendingSeat(g);
    assert.notEqual(seat, null, `对局中应有待行动座位（day=${g.day} ${g.subPhase}）`);
    const phase = logic.phaseOf(g);
    assert.ok(phase, `未知阶段 ${g.phase}:${g.subPhase}`);
    phasesSeen.add(phase);

    const aliveSeats = g.players.filter((p) => p && p.alive).map((p) => p.seat);
    const others = aliveSeats.filter((x) => x !== seat);
    let action;
    let extra;
    switch (phase) {
      case 'wolf':
        [action, extra] = ['wolf-target', { target: aliveSeats[0] }];
        break;
      case 'seer':
        [action, extra] = ['seer-check', { target: others[0] }];
        break;
      case 'witch':
        [action, extra] = ['witch-move', { move: 'skip' }];
        break;
      case 'hunter':
        [action, extra] = ['hunter-shoot', { target: null }];
        break;
      case 'lastwords':
        [action, extra] = ['speak', { text: '我走了，大家按发言和票型好好盘。' }];
        break;
      case 'speak':
        [action, extra] = ['speak', { text: `我是${seat}号，信息有限，先听后面的发言再定票。` }];
        break;
      case 'pk_speak':
        [action, extra] = ['speak', { text: '我是好人，台上另一位更该出，想清楚了再投。' }];
        break;
      case 'vote':
        [action, extra] = ['vote', { target: others[0] }];
        break;
      case 'pk_vote': {
        const t = (g.pkCandidates || []).find((x) => x !== seat);
        [action, extra] = ['vote', { target: t == null ? null : t }];
        break;
      }
      default:
        throw new Error(`未覆盖阶段 ${phase}`);
    }

    /* 身份路由：AI 座位由房主携带 seat 代提交；真人座位用本人 uid（§7.6） */
    const p = g.players[seat - 1];
    const body = p.isAI ? { uid: room.ownerUid, seat, ...extra } : { uid: p.uid, ...extra };
    must(action, body);
  }

  assert.equal(room.game.phase, 'revealed', '联机整局必须收敛');
  assert.ok(room.game.winner === 'good' || room.game.winner === 'wolf', `必须有胜负，实际 ${room.game.winner}`);
  assert.ok(phasesSeen.has('wolf') && phasesSeen.has('speak') && phasesSeen.has('vote'), '必须走完夜晚 / 发言 / 投票');
  assert.ok(room.log.length > 0, '房间公开事件账本非空');
  room.log.forEach((ev, i) => assertPublicHistory(ev, `room.log[${i}]`));

  /* revealed 复盘：全员亮牌（§6 / §7.9），快照公布胜负 */
  for (let seat = 1; seat <= 9; seat++) {
    const snap = logic.snapshotFor(room, seat);
    assert.equal(snap.winner, room.game.winner);
    assert.ok(
      snap.players.every((p) => p && p.role),
      `revealed 后座位 ${seat} 视角应见全员身份`
    );
  }
});

/* ============================================================
 * 3. url-guard 验收条件再覆盖（features.md §10 基线全量）
 * ============================================================ */

test('url-guard：非 http/https 全拒', () => {
  for (const u of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://example.com', 'gopher://x']) {
    assert.ok(typeof checkUrl(u) === 'string', `应拒绝 ${u}`);
  }
});

test('url-guard：localhost / 环回 / 私网 / 保留段全拒', () => {
  for (const u of [
    'http://localhost', // §10 基线
    'http://127.0.0.1', // §10 基线
    'http://192.168.1.1', // §10 基线
    'http://10.0.0.1', // §10 基线
    'https://[::1]/', // §10 基线
    'http://user:pass@example.com', // §10 基线：URL 内嵌账密
    'http://0.0.0.0',
    'http://169.254.169.254', // 云元数据（链路本地）
    'http://172.16.0.1',
    'http://172.31.0.1',
    'http://100.64.0.1',
    'http://192.0.2.1',
    'http://198.18.0.1',
    'http://224.0.0.1',
    'http://255.255.255.255',
    'http://api.local',
    'http://host.internal',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.ok(typeof checkUrl(u) === 'string' && checkUrl(u).length > 0, `应拒绝 ${u}`);
  }
});

test('url-guard：合法公网 https 放行', () => {
  assert.equal(checkUrl('https://api.openai.com'), null); // §10 基线
  assert.equal(checkUrl('https://api.openai.com/v1/chat/completions'), null);
  assert.equal(checkUrl('https://8.8.8.8/v1'), null);
});

/* ============================================================
 * 4. 轮询快照 rev 游标（worker 路由 + fake DO，端到端）
 * ============================================================ */

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
      idFromName: (code) => ({ name: String(code).toUpperCase() }),
      get(id) {
        if (!rooms.has(id.name)) rooms.set(id.name, new Room({ storage: new FakeStorage() }, env));
        const room = rooms.get(id.name);
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

test('rev 游标：无变化回 unchanged，有动作按座位视角递增', async () => {
  resetRoomLimiterForTests();
  const env = makeEnv();
  const ip = { 'cf-connecting-ip': '198.51.100.9' };

  const created = await worker.fetch(post('/api/room/new', { nick: '甲', uid: 'u1' }, ip), env);
  assert.equal(created.status, 200);
  const { code } = await created.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);

  const stateOf = async (uid, rev) =>
    (await worker.fetch(get(`/api/room/${code}/state?uid=${uid}${rev != null ? `&rev=${rev}` : ''}`, ip), env)).json();

  const snap1 = await stateOf('u1');
  assert.equal(typeof snap1.rev, 'number');
  assert.equal(snap1.phase, 'lobby');

  /* 无变化：带当前 rev 轮询 → 几十字节 unchanged 短回包（§2） */
  assert.deepEqual(await stateOf('u1', snap1.rev), { unchanged: true });
  assert.deepEqual(await stateOf('u1', snap1.rev), { unchanged: true }, '连续无变化持续 unchanged');

  /* 有动作（他人进房）→ 房主视角 rev 递增并回全量快照 */
  const joined = await worker.fetch(post(`/api/room/${code}/join`, { nick: '乙', uid: 'u2' }, ip), env);
  assert.equal((await joined.json()).ok, true);
  const snap2 = await stateOf('u1', snap1.rev);
  assert.notDeepEqual(snap2, { unchanged: true }, '有变化不得回 unchanged');
  assert.ok(snap2.rev > snap1.rev, `rev 应递增（${snap1.rev} → ${snap2.rev}）`);
  assert.equal(snap2.players.filter(Boolean).length, 2, '新快照含新进房者');

  /* 游标推进后再次无变化 → unchanged */
  assert.deepEqual(await stateOf('u1', snap2.rev), { unchanged: true });

  /* 新座位自己的视角游标独立起步（ADR-0002：rev 按座位各自计算） */
  const snapB = await stateOf('u2');
  assert.equal(snapB.mySeat, 2);
  assert.equal(typeof snapB.rev, 'number');
  assert.deepEqual(await stateOf('u2', snapB.rev), { unchanged: true });

  /* 不在房内的 uid 轮询 → 404（前端据此判定会话失效） */
  const ghost = await worker.fetch(get(`/api/room/${code}/state?uid=nobody`, ip), env);
  assert.equal(ghost.status, 404);
});
