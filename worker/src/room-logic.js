/* ============================================================
 * worker/src/room-logic.js —— 房间纯逻辑（可测内核，零 I/O）
 * ------------------------------------------------------------
 * 从 DO 壳（room.js）拆出的全部房间规则，node --test 直接可测（ADR-0001
 * 「薄适配」：玩法判定全部调用 shared/game.js 纯函数内核，本层只做
 * 路由存取、座位映射、rev 游标、托管与快照裁剪）。
 * 口径：docs/features.md §2 §4 §7 §8 §9；ADR-0002（ai_view / 按座 rev /
 * 150s 行动超时）。快照裁剪是安全边界（§8.1），永不简化。
 *
 * 房间状态（全部 JSON 可序列化，DO 落 storage）：
 *   code / ownerUid / createdAt / abandoned
 *   game:        shared/game.js 的游戏状态（lobby → night → day → revealed）
 *   lobbyLog:    大厅公开事件（join / ready）
 *   log:         游戏内公开事件（docs/ai-prompts.md §1.3 history schema）
 *   hosted:      托管座位号数组（§7.7 真人 >60s 无心跳转托管）
 *   heartbeats:  { uid → lastSeen }（在线窗口 35s）
 *   ownerOnline: 房主在线（掉线 → 快照显示「等待房主」，§7.6）
 *   revs:        { 座位 → rev } 按座位视角各自计算的游标（ADR-0002）
 *   deadline:    { at, seat } 行动超时 150s（单机 = 真人 ≤1 不设）
 * ============================================================ */

import * as game from '../../shared/game.js';
import { buildMessages } from '../../shared/prompts.js';

export const ACTION_TIMEOUT_MS = 150_000; // §5.11 行动超时（DO alarm）
export const HOST_AFTER_MS = 60_000; // §7.7 无心跳转托管
export const ONLINE_WINDOW_MS = 35_000; // §7.7 在线窗口
export const OWNER_ABANDON_MS = 30 * 60_000; // §7.7 房主失联作废

const clone = (s) => structuredClone(s);
const HUMANS = (g) => g.players.filter((p) => p && !p.isAI).length;

/* ---------- 建房 ---------- */

/** 建房：房主入座 1 号（features.md §7.1），rev 从 1 起。 */
export function createRoom(code, { nick, uid }, now) {
  if (uid == null) return { error: '缺少 uid' };
  const r = game.advance(game.createInitialState(), { type: 'join', nick, uid });
  if (r.error) return { error: r.error };
  return {
    room: {
      code: String(code || ''),
      ownerUid: uid,
      createdAt: now,
      abandoned: false,
      game: r.state,
      lobbyLog: r.events.slice(),
      log: [],
      hosted: [],
      heartbeats: { [uid]: now },
      ownerOnline: true,
      revs: { 1: 1 },
      deadline: null,
    },
  };
}

/* ---------- 座位与心跳 ---------- */

export function seatOfUid(room, uid) {
  const p = room.game.players.find((x) => x && x.uid === uid);
  return p ? p.seat : null;
}

function isOnline(room, now) {
  const seen = room.heartbeats[room.ownerUid];
  return seen != null && now - seen <= ONLINE_WINDOW_MS;
}

/**
 * 心跳 / 任意请求刷新在线状态（§7.7）。
 * 纯函数：返回 { room, changed }；changed=true 表示快照可见状态变了
 * （房主在线翻转、托管座位重连收回控制权），需要走 finalize 提交并持久化；
 * 普通心跳不产生任何 rev 变化（lastSeen 不进快照）。
 */
export function touchHeartbeat(room, uid, now) {
  const draft = clone(room);
  const seat = seatOfUid(draft, uid);
  if (uid == null || seat == null) return { room: draft, changed: false };
  draft.heartbeats[uid] = now;
  let changed = false;
  const p = draft.game.players[seat - 1];
  if (p && !p.isAI && draft.hosted.includes(seat)) {
    draft.hosted = draft.hosted.filter((s) => s !== seat); // 重连（uid）即收回控制权（§7.7）
    changed = true;
  }
  const playing = draft.game.phase === 'night' || draft.game.phase === 'day';
  if (playing) {
    const online = isOnline(draft, now);
    if (online !== !!draft.ownerOnline) {
      draft.ownerOnline = online;
      changed = true;
    }
  }
  if (changed) draft.revs = bumpRevs(room, draft);
  return { room: draft, changed };
}

/* ---------- 快照（按座位裁剪，§8.1 安全边界） ---------- */

/** 子阶段 → AI 任务阶段（shared/prompts.js PHASES，§5.2 映射表逆向）。 */
export function phaseOf(g) {
  switch (`${g.phase}:${g.subPhase}`) {
    case 'night:wolf':
      return 'wolf';
    case 'night:seer':
      return 'seer';
    case 'night:witch':
      return 'witch';
    case 'day:night_hunter':
    case 'day:hunter':
      return 'hunter';
    case 'day:lastwords':
    case 'day:exile_lastwords':
      return 'lastwords';
    case 'day:speak':
      return 'speak';
    case 'day:pk_speak':
      return 'pk_speak';
    case 'day:vote':
      return 'vote';
    case 'day:pk_vote':
      return 'pk_vote';
    default:
      return null;
  }
}

/** 本人私有字段（§4.1.6 夜里可见性：只有本人合法可知的信息）。 */
function privateOf(g, me) {
  const you = { seat: me.seat, alive: !!me.alive, role: me.role };
  if (me.role === 'werewolf') {
    you.wolves = g.players.filter((p) => p && p.role === 'werewolf').map((p) => p.seat);
    if (g.phase === 'night' && me.alive && g.night) {
      if (g.night.blade != null) you.blade = g.night.blade;
      // §4.1.1 狼队密聊与定刀投票：仅存活狼座可见（死者走观战视角，另无此字段）
      you.wolfChat = g.night.wolfChat || [];
      you.wolfVotes = g.night.wolfVotes || {};
      you.captain = game.wolfCaptain(g); // 平票裁定者（由存活狼推得，狼座本可知）
    }
  }
  if (me.role === 'seer') {
    you.checks = (g.seerChecks || []).map((c) => ({ night: c.night, seat: c.target, result: c.isWolf ? 'wolf' : 'good' }));
  }
  if (me.role === 'witch' && g.witch) {
    you.antidote = g.witch.antidote > 0;
    you.poison = g.witch.poison > 0;
    const blade = game.witchSeesBlade(g); // 仅女巫子阶段且解药未用（§4.1.3）
    if (blade != null) you.blade = blade;
  }
  return you;
}

/**
 * 按请求者座位裁剪的快照（纯函数、确定性：不读时钟，rev 比较才可靠）。
 * 夜里只露 phase='night' + day，不露子阶段与轮到谁（§4.1.6 夜视角冻结，
 * ADR-0002）；行动者本人拿到 action；天亮结算全员齐跳靠公开事件驱动。
 * 死亡玩家观战视角可见全员身份（§7.8，仅自己可见）。
 */
export function snapshotFor(room, seat) {
  const g = room.game;
  const night = g.phase === 'night';
  const revealed = g.phase === 'revealed';
  const me = seat >= 1 && seat <= game.SEAT_COUNT ? g.players[seat - 1] : null;
  const spectator = !!(me && g.phase !== 'lobby' && !me.alive && !revealed);
  const pending = g.phase === 'night' || g.phase === 'day' ? game.pendingSeat(g) : null;
  const snap = {
    code: room.code,
    owner: room.ownerUid,
    ownerOnline: !!room.ownerOnline,
    abandoned: room.abandoned,
    mySeat: me ? me.seat : null,
    phase: g.phase,
    day: g.day,
    players: [],
    events: g.phase === 'lobby' ? room.lobbyLog : room.log,
  };
  if (!night) snap.subPhase = g.subPhase; // 夜里不露子阶段（§4.1.6）
  if (!night && pending != null) snap.pending = pending;
  /* 白天透出行动倒计时（供 UI 吸顶状态条）；夜里不透——deadline.seat 即轮到谁，
     会从快照泄漏夜里行动顺序（§4.1.6） */
  if (!night && !revealed && room.deadline) snap.deadline = room.deadline;
  if (!night && g.pkCandidates) snap.pkCandidates = g.pkCandidates;
  if (revealed) {
    snap.winner = g.winner;
    snap.reason = g.reason;
  }
  snap.players = g.players.map((p) => {
    if (!p) return null;
    const entry = { seat: p.seat, nick: p.nick, isAI: !!p.isAI, alive: !!p.alive };
    if (room.hosted.includes(p.seat)) entry.hosted = true; // 托管标（§7.7 公开）
    if (g.phase === 'lobby') entry.ready = !!p.ready;
    if (revealed || spectator || p.seat === seat) {
      entry.role = p.role;
      if (p.death) entry.death = p.death;
    }
    return entry;
  });
  if (me) snap.you = privateOf(g, me);
  if (me && pending === me.seat && phaseOf(g)) snap.action = { kind: phaseOf(g) };
  else if (me && me.alive && me.role === 'werewolf' && g.phase === 'night' && g.subPhase === 'wolf') {
    snap.action = { kind: 'wolf' }; // §4.1.1 狼队密聊+投票全员开放；非狼座位绝不带此字段
  }
  if (!revealed && g.phase !== 'lobby' && pending != null && !room.ownerOnline) {
    const p = g.players[pending - 1];
    if (p && (p.isAI || room.hosted.includes(pending))) snap.waitingOwner = true; // §7.6 等待房主
  }
  return snap;
}

/* ---------- rev 游标（ADR-0002：按座位视角各自计算） ---------- */

/** 逐座位比较快照内容，变化者 rev+1；空位与未变者不动。 */
function bumpRevs(oldRoom, draft) {
  const revs = { ...draft.revs };
  for (let seat = 1; seat <= game.SEAT_COUNT; seat++) {
    const p = draft.game.players[seat - 1];
    if (!p) continue;
    if (JSON.stringify(snapshotFor(oldRoom, seat)) !== JSON.stringify(snapshotFor(draft, seat))) {
      revs[seat] = (revs[seat] || 0) + 1;
    }
  }
  return revs;
}

/** 单机（真人 ≤1）不设行动超时（§5.11）；其余按待行动座位计时。 */
function refreshDeadline(draft, now) {
  const g = draft.game;
  if (g.phase !== 'night' && g.phase !== 'day') {
    draft.deadline = null;
    return;
  }
  if (HUMANS(g) <= 1) {
    draft.deadline = null;
    return;
  }
  const pending = game.pendingSeat(g);
  draft.deadline = pending != null ? { at: now + ACTION_TIMEOUT_MS, seat: pending } : null;
}

/** 提交：事件入账 + rev 重算 + 超时重排。old = 提交前状态，draft = 已变更草稿。 */
function finalize(oldRoom, draft, now) {
  draft.revs = bumpRevs(oldRoom, draft);
  refreshDeadline(draft, now);
  return draft;
}

/* ---------- 公开事件 → history（docs/ai-prompts.md §1.3） ---------- */

function toHistory(ev) {
  switch (ev.type) {
    case 'day_announce':
      return [{ t: 'deaths', day: ev.day, seats: ev.dead }];
    case 'last_words':
      return [{ t: 'lastwords', day: ev.day, seat: ev.seat, text: ev.text }];
    case 'speech':
      return [{ t: 'speech', day: ev.day, seat: ev.seat, text: ev.text }];
    case 'pk_speech':
      return [{ t: 'pk_speak', day: ev.day, seat: ev.seat, text: ev.text }];
    case 'vote':
      return [{ t: 'vote', day: ev.day, voter: ev.seat, target: ev.target }];
    case 'vote_result': {
      const out = [];
      if (ev.pk) out.push({ t: 'tie', day: ev.day, seats: ev.pk });
      out.push({ t: 'exile', day: ev.day, seat: ev.exiled == null ? null : ev.exiled });
      return out;
    }
    case 'hunter_shoot':
      return [{ t: 'hunter', day: ev.day, seat: ev.seat, target: ev.target }];
    case 'hunter_skip':
      return [{ t: 'hunter', day: ev.day, seat: ev.seat, target: null }];
    default:
      return []; // game_start / game_over（快照从 state 读）、hunter_flip（并入 hunter 事件）
  }
}

/* ---------- 动作（features.md §9 路由表 → shared/game.js 内核） ---------- */

const GAME_ACTIONS = {
  speak: (b, seat) => ({ type: 'speak', seat, text: b.text }),
  vote: (b, seat) => ({ type: 'vote', seat, target: b.target }),
  'wolf-chat': (b, seat) => ({ type: 'wolf_chat', seat, text: b.text }),
  'wolf-target': (b, seat) => ({ type: 'wolf_target', seat, target: b.target }),
  'seer-check': (b, seat) => ({ type: 'seer_check', seat, target: b.target }),
  'witch-move': (b, seat) => ({ type: 'witch_move', seat, move: b.move, target: b.target }),
  'hunter-shoot': (b, seat) => ({ type: 'hunter_shoot', seat, target: b.target }),
};

/**
 * 解析行动座位：默认 uid 本人；房主可带 seat 代 AI / 托管座位行动
 * （§7.6 AI 驱动者 = 房主）。返回 { seat, own } 或 { error }。
 * AI 座位不认 uid 直投（uid 是自声明身份，只能由房主以 seat 参数驱动）。
 */
function resolveActor(room, body) {
  const uid = body.uid;
  if (uid == null) return { error: '缺少 uid' };
  const own = seatOfUid(room, uid);
  let seat = own;
  if (body.seat != null && body.seat !== own) {
    if (uid !== room.ownerUid) return { error: '仅房主可代 AI 或托管座位行动' };
    const p = room.game.players[body.seat - 1];
    if (!p || (!p.isAI && !room.hosted.includes(body.seat))) {
      return { error: '目标座位不是 AI 座位或托管中的座位' };
    }
    seat = body.seat;
  } else if (own != null) {
    const p = room.game.players[own - 1];
    if (p.isAI) return { error: 'AI 座位行动由房主携带 seat 参数提交' };
  }
  if (seat == null) return { error: '不在房间内' };
  return { seat, own };
}

/** 游戏动作统一入口（DO 的 HTTP 动作与服务端 AI 路径共用同一提交管线）。 */
export function applyGameAction(room, gameAction, now) {
  const r = game.advance(room.game, gameAction);
  if (r.error) return { error: r.error };
  const draft = clone(room);
  draft.game = r.state;
  for (const ev of r.events) draft.log.push(...toHistory(ev));
  return { room: finalize(room, draft, now) };
}

/** 确定性回退（§8.4 / §5.11：DO 150s 超时兜底与服务端 AI 失败共用）。 */
export function applyFallbackFor(room, seat, now) {
  const r = game.applyFallback(room.game, seat);
  if (r.error) return { error: r.error };
  const draft = clone(room);
  draft.game = r.state;
  for (const ev of r.events) draft.log.push(...toHistory(ev));
  return { room: finalize(room, draft, now) };
}

/**
 * 房内动作（HTTP 侧，features.md §9）。返回 { room, error, data, persist }。
 * persist=false 表示无快照可见变化（纯心跳），DO 可跳过持久化。
 */
export function applyAction(room, httpAction, body, ctx) {
  const now = ctx.now;
  if (room.abandoned) return { error: '房主失联，房间已作废，请重建新房' }; // §7.7 只读
  switch (httpAction) {
    case 'heartbeat': {
      const t = touchHeartbeat(room, body.uid, now);
      return t.changed ? { room: t.room } : { room: t.room, persist: false };
    }
    case 'join': {
      const r = game.advance(room.game, { type: 'join', nick: body.nick, uid: body.uid });
      if (r.error) return { error: r.error };
      const draft = clone(room);
      draft.game = r.state;
      draft.lobbyLog.push(...r.events);
      if (body.uid != null) draft.heartbeats[body.uid] = now;
      return { room: finalize(room, draft, now), data: { seat: r.events[0].seat } };
    }
    case 'ready': {
      const seat = seatOfUid(room, body.uid);
      if (seat == null) return { error: '不在房间内' };
      const r = game.advance(room.game, { type: 'ready', seat, ready: body.ready === true });
      if (r.error) return { error: r.error };
      const draft = clone(room);
      draft.game = r.state;
      draft.lobbyLog.push(...r.events);
      if (body.uid != null) draft.heartbeats[body.uid] = now;
      return { room: finalize(room, draft, now) };
    }
    case 'start': {
      if (body.uid !== room.ownerUid) return { error: '仅房主可以开始游戏' };
      if (!Number.isInteger(ctx.seed)) return { error: '缺少发牌种子' };
      const r = game.advance(room.game, { type: 'start', seed: ctx.seed });
      if (r.error) return { error: r.error };
      const draft = clone(room);
      draft.game = r.state;
      draft.heartbeats[room.ownerUid] = now;
      /* §7.4：内核一次原子完成补位到 9 + 洗牌发牌 + 进入 night_1 */
      return {
        room: finalize(room, draft, now),
        data: { aiFilled: r.state.players.filter((p) => p && p.isAI).length },
      };
    }
    default: {
      const build = GAME_ACTIONS[httpAction];
      if (!build) return { error: `未知动作：${httpAction}` };
      const actor = resolveActor(room, body);
      if (actor.error) return { error: actor.error };
      const r = game.advance(room.game, build(body, actor.seat));
      if (r.error) return { error: r.error };
      const draft = clone(room);
      draft.game = r.state;
      for (const ev of r.events) draft.log.push(...toHistory(ev));
      if (actor.own != null && draft.hosted.includes(actor.own)) {
        draft.hosted = draft.hosted.filter((s) => s !== actor.own); // 本人行动即收回托管（§7.7）
      }
      if (body.uid != null) draft.heartbeats[body.uid] = now;
      return { room: finalize(room, draft, now) };
    }
  }
}

/* ---------- ai_view（owner 专属，ADR-0002） ---------- */

/* game 内核角色名 → AI 契约角色名（docs/ai-prompts.md §1.2：wolf/villager/seer/witch/hunter） */
const PROMPT_ROLE = { werewolf: 'wolf', villager: 'villager', seer: 'seer', witch: 'witch', hunter: 'hunter' };

/** 该座位自己的身份卡（docs/ai-prompts.md §1.2 roleCard schema）。 */
export function roleCardOf(g, seat) {
  const p = g.players[seat - 1];
  if (!p) return null;
  const card = { seat, role: PROMPT_ROLE[p.role] || p.role };
  if (p.role === 'werewolf') {
    card.wolves = g.players.filter((x) => x && x.role === 'werewolf').map((x) => x.seat);
    if (g.phase === 'night' && g.subPhase === 'wolf' && g.night) {
      card.wolfChat = g.night.wolfChat || []; // §4.1.1 狼自己的私有频道进 roleCard（上下文铁律不破）
      card.wolfVotes = g.night.wolfVotes || {};
      card.captain = game.wolfCaptain(g);
    }
  }
  if (p.role === 'seer') card.checks = (g.seerChecks || []).map((c) => ({ night: c.night, seat: c.target, result: c.isWolf ? 'wolf' : 'good' }));
  if (p.role === 'witch' && g.witch) {
    card.antidote = g.witch.antidote > 0;
    card.poison = g.witch.poison > 0;
  }
  const blade = game.witchSeesBlade(g);
  if (p.role === 'witch' && blade != null) card.knifeTarget = blade; // 仅女巫行动夜（§1.2）
  return card;
}

/** ai_view 载荷：AI / 托管座位的完整私有视角（驱动者组装提示词的唯一来源）。 */
export function aiView(room, seat) {
  const g = room.game;
  const card = roleCardOf(g, seat);
  if (!card) return { error: '座位不存在' };
  const p = g.players[seat - 1];
  const view = { ...card, nick: p.nick, isAI: !!p.isAI, hosted: room.hosted.includes(seat) };
  if (p.role === 'werewolf' && g.phase === 'night' && g.night && g.night.blade != null) {
    view.blade = g.night.blade; // 存活狼当晚知晓刀口（§4.1.6）
  }
  return { view };
}

/* ---------- AI 请求契约（docs/ai-prompts.md §5.0 / §5.4） ---------- */

/** 更早天数的死讯流水行（§5.4）：dead 必须完整列出该天全部出局座位。 */
function digestOfDay(day, evs) {
  const dead = new Set();
  const parts = [];
  for (const ev of evs) {
    if (ev.t === 'deaths') {
      ev.seats.forEach((s) => dead.add(s));
      parts.push(ev.seats.length ? `昨晚 ${ev.seats.join('、')} 号死亡` : '平安夜');
    } else if (ev.t === 'exile') {
      if (ev.seat != null) {
        dead.add(ev.seat);
        parts.push(`${ev.seat} 号被放逐`);
      } else parts.push('无人出局');
    } else if (ev.t === 'hunter' && ev.target != null) {
      dead.add(ev.target);
      parts.push(`猎人 ${ev.seat} 号带走 ${ev.target} 号`);
    }
  }
  return { t: 'digest', day, dead: [...dead].sort((a, b) => a - b), text: parts.join('，') || '平安日' };
}

/**
 * 历史窗口（§5.4）：最近 2 个完整白天（+ 当前未完天）全量，更早天数各压成
 * 一条 digest；逼近 64KB 时从最旧丢弃（先整条 digest 天，再最旧全量天）。
 * 同一天要么全量要么 digest，不混给（防死亡双计）。
 */
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
    out.shift();
    json = JSON.stringify(out);
  }
  return out;
}

/**
 * 组装 OpenAI 兼容请求体（§5.0 唯一格式；消息结构两种发起路径一字不差）。
 * 返回 { error } 或 { url, body }；body.ready 直接送 proxyFetch。
 */
export function buildAIRequest(room, seat, cfg) {
  const g = room.game;
  const phase = phaseOf(g);
  if (!phase) return { error: '当前没有待执行的 AI 任务' };
  const card = roleCardOf(g, seat);
  if (!card) return { error: '座位不存在' };
  try {
    const messages = buildMessages(windowHistory(room.log), card, phase);
    const url = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
    return { url, body: { model: cfg.model, messages, temperature: 0.7, max_tokens: 800 } };
  } catch (e) {
    return { error: String((e && e.message) || e) }; // prompts 校验失败 → 调用方走确定性回退
  }
}

/**
 * §4.1.1 狼阶段回复解析（两行格式）：第一行密聊发言（「过」/空 → 无话），
 * 第二行（或剩余文本）取第一个 1–9 数字为投票。target 为 null 时调用方走
 * 确定性回退随机投票，密聊内容保留。
 */
export function parseWolfReply(text) {
  const out = { chat: null, target: null };
  if (typeof text !== 'string') return out;
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return out;
  const strip = (l) => l.replace(/[\s.,;:!?，。；：！？、"'`()[\]{}<>《》-]/g, '');
  if (lines.length === 1) {
    const one = strip(lines[0]);
    if (/^[1-9]$/.test(one)) out.target = Number(one);
    else out.chat = cleanChat(lines[0]);
    return out;
  }
  out.chat = cleanChat(lines[0]);
  const m = lines.slice(1).join(' ').match(/[1-9]/);
  out.target = m ? Number(m[0]) : null;
  return out;
}

function cleanChat(line) {
  const t = line.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  if (!t || ['过', 'pass', 'skip', '无', '没事'].includes(t.toLowerCase())) return null;
  return t.slice(0, 60); // 与内核 WOLF_CHAT_MAX 同口径截断
}

/** §5.1 宽容解析：先判 save / skip，再取第一个 1–9 数字；失败返回 null（回退）。
 *  狼阶段不走此函数（两行格式，见 parseWolfReply）。 */
export function parseAIReply(phase, text) {
  if (typeof text !== 'string') return null;
  if (phase === 'speak' || phase === 'lastwords' || phase === 'pk_speak') {
    const t = text.trim().slice(0, 200); // >200 截断（§5.8 硬上限）
    return t ? { type: 'speak', text: t } : null;
  }
  const s = text.trim().toLowerCase().replace(/[\s.,;:!?，。；：！？、"'`()[\]{}<>《》-]/g, '');
  if (s === 'save') return phase === 'witch' ? { type: 'witch_move', move: 'save' } : null;
  if (s === 'skip' || s === 'pass') {
    if (phase === 'witch') return { type: 'witch_move', move: 'skip' };
    if (phase === 'hunter') return { type: 'hunter_shoot', target: null };
    if (phase === 'vote' || phase === 'pk_vote') return { type: 'vote', target: null };
    return null; // wolf / seer 不可 skip（§5.10 / §4.1.2）→ 解析失败走回退
  }
  const m = s.match(/[1-9]/);
  if (!m) return null;
  const n = Number(m[0]);
  switch (phase) {
    case 'seer':
      return { type: 'seer_check', target: n };
    case 'witch':
      return { type: 'witch_move', move: 'poison', target: n };
    case 'hunter':
      return { type: 'hunter_shoot', target: n };
    case 'vote':
    case 'pk_vote':
      return { type: 'vote', target: n };
    default:
      return null;
  }
}

/* ---------- sweep（DO alarm：托管 / 行动超时 / 房主作废，§7.7） ---------- */

/**
 * 时钟驱动的房间巡检（纯函数，DO alarm 与每次请求后可调）：
 *   1. 真人 >60s 无心跳 → 转托管（联机，真人 >1）；
 *   2. 行动超时 150s → 确定性回退推进 + 该座位转托管（§5.11）；
 *   3. 房主失联 >30min → 房间作废（联机 only；单机无他人等待，不做）；
 *   4. 房主在线翻转（35s 窗口）。
 * 返回 { room, changed }；changed=false 时 DO 无需持久化。
 */
export function sweep(room, now) {
  const draft = clone(room);
  const g = draft.game;
  if (draft.abandoned || (g.phase !== 'night' && g.phase !== 'day')) {
    return { room: draft, changed: false };
  }
  if (HUMANS(g) <= 1) return { room: draft, changed: false }; // 单机：不超时不作废（§5.11 / §6）
  let changed = false;
  const ownerSeen = draft.heartbeats[draft.ownerUid] ?? draft.createdAt;
  if (now - ownerSeen > OWNER_ABANDON_MS) {
    draft.abandoned = true; // §7.7 作废只读
    changed = true;
  } else {
    const online = now - ownerSeen <= ONLINE_WINDOW_MS;
    if (online !== !!draft.ownerOnline) {
      draft.ownerOnline = online;
      changed = true;
    }
    for (const p of g.players) {
      if (!p || p.isAI || !p.alive || draft.hosted.includes(p.seat)) continue;
      const seen = draft.heartbeats[p.uid] ?? draft.createdAt;
      if (now - seen > HOST_AFTER_MS) {
        draft.hosted.push(p.seat);
        changed = true;
      }
    }
    if (draft.deadline && now >= draft.deadline.at) {
      const pending = game.pendingSeat(g);
      if (pending === draft.deadline.seat) {
        const r = game.applyFallback(g, pending);
        if (!r.error) {
          draft.game = r.state;
          for (const ev of r.events) draft.log.push(...toHistory(ev));
          const p = r.state.players[pending - 1];
          if (p && !p.isAI && !draft.hosted.includes(pending)) draft.hosted.push(pending);
          changed = true;
        }
      }
      draft.deadline = null;
    }
  }
  if (changed) {
    draft.revs = bumpRevs(room, draft);
    refreshDeadline(draft, now); // 只有状态推进（回退生效）才重排 150s 计时
  }
  return { room: draft, changed };
}

/** 下一次 alarm 时刻；null = 无需计时。 */
export function nextAlarmAt(room, now) {
  const g = room.game;
  if (room.abandoned || (g.phase !== 'night' && g.phase !== 'day')) return null;
  const times = [];
  if (room.deadline) times.push(room.deadline.at);
  if (HUMANS(g) > 1) {
    const ownerSeen = room.heartbeats[room.ownerUid] ?? room.createdAt;
    times.push(ownerSeen + (room.ownerOnline ? ONLINE_WINDOW_MS : OWNER_ABANDON_MS));
    for (const p of g.players) {
      if (!p || p.isAI || !p.alive || room.hosted.includes(p.seat)) continue;
      times.push((room.heartbeats[p.uid] ?? room.createdAt) + HOST_AFTER_MS);
    }
  }
  if (!times.length) return null;
  return Math.max(now + 1, Math.min(...times));
}
