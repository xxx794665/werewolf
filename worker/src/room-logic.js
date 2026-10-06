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
 *   ownerOnline: 房主在线（掉线 → 快照 serverDrive=true，AI 已由服务端闹钟接管，§4.2 / ADR-0016）
 *   revs:        { 座位 → rev } 按座位视角各自计算的游标（ADR-0002）
 *   deadline:    { at, seat } 行动超时 150s（单机 = 真人 ≤1 不设）
 * ============================================================ */

import * as game from '../../shared/game.js';
import { buildMessages, clampMaxTokens, clipSpeech } from '../../shared/prompts.js';

export const ACTION_TIMEOUT_MS = 150_000; // §5.11 行动超时（DO alarm）
export const HOST_AFTER_MS = 60_000; // §7.7 无心跳转托管
export const ONLINE_WINDOW_MS = 35_000; // §7.7 在线窗口
export const OWNER_ABANDON_MS = 30 * 60_000; // §7.7 作废窗口（§4.1 修订：全员失联口径，ADR-0016）
export const AI_DRIVE_CADENCE_MS = 5_000; // §4.1（ADR-0016）闹钟接管节拍：房主掉线期间每 5s 驱动一拍

const clone = (s) => structuredClone(s);
const HUMANS = (g) => g.players.filter((p) => p && !p.isAI).length;

/* §4.1（ADR-0016）全员最近心跳：任何真人（含房主）30 分钟内心跳出现过即不作废。
 * 作废判定与 nextAlarmAt 的作废分量共用——旧公式只看房主会算出过去时刻，
 * 被 Math.max(now+1,…) 钳成毫秒级 alarm 热循环烧 CF 配额（裁定 8）。 */
function latestHumanSeen(room, g = room.game) {
  let latest = room.createdAt; // 无心跳记录的兜底下界
  for (const p of g.players) {
    if (!p || p.isAI) continue;
    const seen = room.heartbeats[p.uid] ?? room.createdAt;
    if (seen > latest) latest = seen;
  }
  return latest;
}

/**
 * §4.1（ADR-0016）闹钟接管条件（纯函数，测试直测）：联机中房主失联（35s 窗口）
 * 且当前待行动座位是 AI / 托管座位 → DO alarm 以 AI_DRIVE_CADENCE_MS 节拍自动驱动。
 * 房主心跳恢复即假 → 节拍自然停（房主客户端 4s 兜底节拍照常驱动）。
 * abandoned 房间不再接管（applyGameAction 不查 abandoned，闸门必须在此拦）。
 */
export function alarmDriveDue(room, now) {
  const g = room.game;
  if (room.abandoned || (g.phase !== 'night' && g.phase !== 'day')) return false;
  if (HUMANS(g) <= 1) return false; // 单机：客户端 soloDrive 自己驱动，服务端不接管
  if (isOnline(room, now)) return false; // 房主在线（心跳直算，精确于 ownerOnline 懒标志）
  const pending = game.pendingSeat(g);
  if (pending == null) return false;
  const p = g.players[pending - 1];
  return !!(p && (p.isAI || room.hosted.includes(pending)));
}

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
    case 'night:guard':
      return 'guard'; // §1.3（ADR-0013）守卫守护
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
    case 'day:elect_join':
      return 'elect_join'; // §2.6（ADR-0014）警长竞选
    case 'day:elect_withdraw':
      return 'elect_withdraw';
    case 'day:elect_campaign':
      return 'elect_campaign';
    case 'day:elect_pk_speak':
      return 'elect_pk_speak'; // 裁定 6：平票自辩单独成任务
    case 'day:elect_vote':
    case 'day:elect_pk_vote':
      return 'elect_vote'; // §2.6：PK 轮与主轮同为警长票（候选集由任务文案收窄）
    case 'day:badge':
      return 'badge'; // §2.3 警徽处置
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

/** 本人私有字段（§4.1.6 夜里可见性：只有本人合法可知的信息）。
 *  §1.2（ADR-0013）狼王同口径：狼队名单 / 密聊 / 狼票 / 刀口 / 队长全按 isWolf；
 *  §1.3 裁定 10：guardLast（昨晚守护座位）仅守卫座携带。 */
function privateOf(g, me) {
  const you = { seat: me.seat, alive: !!me.alive, role: me.role };
  if (game.isWolf(me.role)) {
    you.wolves = g.players.filter((p) => p && game.isWolf(p.role)).map((p) => p.seat);
    // §4.1.1 狼队密聊全程日志：跨夜保留，存活狼座白天也能回看（死者走观战视角，另无此字段）
    if (me.alive) you.wolfChatLog = g.wolfChatLog || [];
    if (g.phase === 'night' && me.alive && g.night) {
      if (g.night.blade != null) you.blade = g.night.blade;
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
  if (me.role === 'guard') {
    you.guardLast = g.guard && g.guard.last != null ? g.guard.last : null; // 裁定 10：连守限制依据
  }
  if (me.idiotRevealed) you.idiotRevealed = true; // §1.4：翻牌白痴失去投票权（本人提示）
  return you;
}

/**
 * 按请求者座位裁剪的快照（纯函数、确定性：不读时钟，rev 比较才可靠）。
 * 夜里只露 phase='night' + day，不露子阶段与轮到谁（§4.1.6 夜视角冻结，
 * ADR-0002）；行动者本人拿到 action；天亮结算全员齐跳靠公开事件驱动。
 * 死亡玩家在提交完自己的行动（遗言 / 开枪）后进入观战视角、可见全员身份
 * （§7.8，仅自己可见）；轮到自己留遗言时仍按暗牌口径只看自己身份
 * （2026-10-03 试玩反馈：亮牌不得早于本人遗言提交）。
 */
export function snapshotFor(room, seat) {
  const g = room.game;
  const night = g.phase === 'night';
  const revealed = g.phase === 'revealed';
  const me = seat >= 1 && seat <= game.SEAT_COUNT ? g.players[seat - 1] : null;
  const pending = g.phase === 'night' || g.phase === 'day' ? game.pendingSeat(g) : null;
  const spectator = !!(me && g.phase !== 'lobby' && !me.alive && !revealed && pending !== me.seat);
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
  /* §1.6 / §2.5（ADR-0013/0014）公开层新字段（值稳定 / 公开信息，不破夜冻结）：
   *   board：板子 id（hStart 落账起带；旧房缺省不带）；sheriff：警长座位（对局
   *   全程公开，夜也带——警长身份是公开信息）；election：竞选公开举手信息
   *   （仅白天竞选期间）；badge 不需要（pending 已在 snap.pending） */
  if (g.board != null) snap.board = g.board;
  if (g.sheriff) snap.sheriff = { seat: g.sheriff.seat == null ? null : g.sheriff.seat };
  const el = g.sheriff && g.sheriff.election;
  if (!night && el) {
    snap.election = {
      stage: el.stage,
      candidates: (el.candidates || []).slice(),
      ...(el.stage === 'join' ? { run: { ...el.run } } : {}),
      ...(el.stage === 'withdraw' ? { quit: { ...el.quit } } : {}),
      ...(el.pkCandidates && el.pkCandidates.length ? { pkCandidates: el.pkCandidates.slice() } : {}), // 裁定 11：PK 台名单（elect_pk_vote 面板候选）
    };
  }
  /* 行动倒计时（§5.11，吸顶状态条数据源）：白天全员可见；夜里仅行动者本人
     可见——deadline.seat 即轮到谁，透给非行动座位会泄漏夜里行动顺序（§4.1.6），
     行动者本人本就知道轮到自己，无新信息 */
  if (!revealed && room.deadline && (!night || pending === seat)) snap.deadline = room.deadline;
  if (!night && g.pkCandidates) snap.pkCandidates = g.pkCandidates;
  if (revealed) {
    snap.winner = g.winner;
    snap.reason = g.reason;
  }
  snap.players = g.players.map((p) => {
    if (!p) return null;
    const entry = { seat: p.seat, nick: p.nick, isAI: !!p.isAI, alive: !!p.alive };
    if (room.hosted.includes(p.seat)) entry.hosted = true; // 托管标（§7.7 公开）
    if (p.idiotRevealed) entry.idiotRevealed = true; // §1.4（ADR-0013）白痴翻牌态：vote_result 公开事件已宣告，属公开信息
    if (g.phase === 'lobby') entry.ready = !!p.ready;
    if (revealed || spectator || p.seat === seat) {
      entry.role = p.role;
      if (p.death) entry.death = p.death;
    }
    return entry;
  });
  if (me) snap.you = privateOf(g, me);
  if (me && pending === me.seat && phaseOf(g)) snap.action = { kind: phaseOf(g) };
  else if (me && me.alive && game.isWolf(me.role) && g.phase === 'night' && g.subPhase === 'wolf') {
    snap.action = { kind: 'wolf' }; // §4.1.1 狼队密聊+投票全员开放（§1.2 狼王同口径）；非狼座位绝不带此字段
  }
  if (!revealed && g.phase !== 'lobby' && pending != null && !room.ownerOnline) {
    const p = g.players[pending - 1];
    if (p && (p.isAI || room.hosted.includes(pending))) snap.serverDrive = true; // §4.2（ADR-0016）waitingOwner 更名：服务端闹钟已接管
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
      /* §1.5（ADR-0013）白痴翻牌免死标记：仅 idiot:true 时带字段，缺省省略保旧形状 */
      const exile = { t: 'exile', day: ev.day, seat: ev.exiled == null ? null : ev.exiled };
      if (ev.idiot) exile.idiot = true;
      out.push(exile);
      return out;
    }
    case 'hunter_shoot':
    case 'hunter_skip': {
      /* §1.5（ADR-0013）狼王翻牌可选 role：仅带值时写字段，缺省省略按猎人渲染 */
      const h = { t: 'hunter', day: ev.day, seat: ev.seat, target: ev.type === 'hunter_skip' ? null : ev.target };
      if (ev.role) h.role = ev.role;
      return [h];
    }
    /* ---------- 警长竞选与警徽流（附录 t-schema 最终版，ADR-0014） ---------- */
    case 'elect_run':
      return [{ t: 'elect_run', day: ev.day, seat: ev.seat, run: ev.run }];
    case 'elect_speech':
      return [{ t: 'elect_speech', day: ev.day, seat: ev.seat, text: ev.text }];
    case 'elect_withdraw':
      return [{ t: 'elect_withdraw', day: ev.day, seat: ev.seat, quit: ev.quit }];
    case 'elect_vote':
      return [{ t: 'elect_vote', day: ev.day, voter: ev.seat, target: ev.target }];
    case 'sheriff_result': {
      const s = { t: 'sheriff', day: ev.day, kind: ev.kind };
      if (ev.seat != null) s.seat = ev.seat;
      if (ev.pk != null) s.pk = ev.pk;
      return [s];
    }
    case 'badge_move': {
      /* badge_move 并入 t:'sheriff'（kind transfer/destroy，带 from/to，附录最终版） */
      const b = { t: 'sheriff', day: ev.day, kind: ev.to == null ? 'destroy' : 'transfer', from: ev.from };
      if (ev.to != null) b.to = ev.to;
      return [b];
    }
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
  'guard-protect': (b, seat) => ({ type: 'guard_protect', seat, target: b.target }), // §1.3（ADR-0013）守卫守护
  'seer-check': (b, seat) => ({ type: 'seer_check', seat, target: b.target }),
  'witch-move': (b, seat) => ({ type: 'witch_move', seat, move: b.move, target: b.target }),
  'hunter-shoot': (b, seat) => ({ type: 'hunter_shoot', seat, target: b.target }),
  /* §2.6（ADR-0014）警长竞选与警徽流路由：body 字段透传，形状校验交内核
   * （run/quit 非布尔 → 内核 fail，不静默降级）；badge 阶段行动者是死亡警长，
   * resolveActor 本人 uid 直投 / 房主 seat 代打与遗言死者同权限模型（B3-5） */
  'elect-run': (b, seat) => ({ type: 'elect_run', seat, run: b.run }),
  'elect-speak': (b, seat) => ({ type: 'elect_speak', seat, text: b.text }),
  'elect-withdraw': (b, seat) => ({ type: 'elect_withdraw', seat, quit: b.quit }),
  'elect-vote': (b, seat) => ({ type: 'elect_vote', seat, target: b.target }),
  'badge-move': (b, seat) => ({ type: 'badge_move', seat, target: b.target }),
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
      /* roster = DO 壳用 shared/roster.js 抽好的开局名册（人格 × 网名，与身份无关，
         ADR-0009）；缺席时内核回退默认昵称 AI-n（部署过渡 / 旧调用方兼容）。
         board = 房主在大厅选的板子 id（§1.1，ADR-0013）：透传给内核 hStart 校验
         （非法 → fail「未知板子」→ 400）；缺省不传由内核落 'standard'（旧客户端兼容）。 */
      const r = game.advance(room.game, { type: 'start', seed: ctx.seed, roster: ctx.roster, board: ctx.board });
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

/* game 内核角色名 → AI 契约角色名（docs/ai-prompts.md §1.2）；
 * §1.2–1.4（ADR-0013）三新角色契约名与内核同名，显式列出防漂移（双份同口径） */
const PROMPT_ROLE = {
  werewolf: 'wolf', wolfking: 'wolfking', villager: 'villager', seer: 'seer',
  witch: 'witch', hunter: 'hunter', guard: 'guard', idiot: 'idiot',
};

/** 该座位自己的身份卡（docs/ai-prompts.md §1.2 roleCard schema）。
 *  §1.6 / 裁定 9–10（ADR-0013/0014）：board / sheriff / election 是公开层字段
 *  （roster 同款先例），guardLast 是守卫私有字段（仅守卫座携带）。
 *  与 js/ai.js roleCardOf 双份同口径（ADR-0004）。 */
export function roleCardOf(g, seat) {
  const p = g.players[seat - 1];
  if (!p) return null;
  const card = { seat, role: PROMPT_ROLE[p.role] || p.role };
  /* 公开层（ADR-0009）：全员昵称对照进卡——AI 需要知道名录才能被称呼；
   * 本人 persona（开局名册抽取的言行风格，非身份信息）只对 AI 座位存在 */
  card.roster = g.players.filter(Boolean).map((x) => ({ seat: x.seat, nick: x.nick }));
  if (p.persona) card.persona = p.persona;
  card.board = g.board || 'standard'; // §1.6 板子 id（旧房间 g.board 缺失兜底）
  card.sheriff = g.sheriff && g.sheriff.seat != null ? g.sheriff.seat : null; // 裁定 9：警长座位公开
  const el = g.sheriff && g.sheriff.election;
  if (el) {
    /* 裁定 9/11：竞选公开层——主轮 elect_vote 候选来源 + PK 台名单 */
    card.election = { candidates: (el.candidates || []).slice(), pk: (el.pkCandidates || []).slice() };
  }
  if (game.isWolf(p.role)) {
    card.wolves = g.players.filter((x) => x && game.isWolf(x.role)).map((x) => x.seat); // §1.2 狼王同列
    card.wolfChatLog = g.wolfChatLog || []; // §4.1.1 狼队私有频道全程日志（跨夜保留；白天任务也带）
    if (g.phase === 'night' && g.subPhase === 'wolf' && g.night) {
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
  if (p.role === 'guard') {
    card.guardLast = g.guard && g.guard.last != null ? g.guard.last : null; // 裁定 10：连守限制依据（仅守卫座携带）
  }
  return card;
}

/** ai_view 载荷：AI / 托管座位的完整私有视角（驱动者组装提示词的唯一来源）。 */
export function aiView(room, seat) {
  const g = room.game;
  const card = roleCardOf(g, seat);
  if (!card) return { error: '座位不存在' };
  const p = g.players[seat - 1];
  const view = { ...card, nick: p.nick, isAI: !!p.isAI, hosted: room.hosted.includes(seat) };
  if (game.isWolf(p.role) && g.phase === 'night' && g.night && g.night.blade != null) {
    view.blade = g.night.blade; // 存活狼当晚知晓刀口（§4.1.6；§1.2 狼王同口径，ADR-0013）
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
        /* §1.4（ADR-0013）白痴翻牌免死：存活（只失去投票权），不得计入 dead
         * ——否则 buildMessages 的存活推导出错，后续动作全部干跑失败 */
        if (ev.idiot === true) parts.push(`${ev.seat} 号翻牌白痴，放逐无效`);
        else {
          dead.add(ev.seat);
          parts.push(`${ev.seat} 号被放逐`);
        }
      } else parts.push('无人出局');
    } else if (ev.t === 'hunter' && ev.target != null) {
      dead.add(ev.target);
      /* §1.5（ADR-0013）狼王翻牌带走人：文案按 role 泛化，dead 推导不变 */
      parts.push(`${ev.role === 'wolfking' ? '狼王' : '猎人'} ${ev.seat} 号带走 ${ev.target} 号`);
    } else if (ev.t === 'sheriff') {
      /* 裁定 9（ADR-0014）：警长信息保留一行摘要——老天数 AI 才推得出警长与
       * 1.5 票；elect_* 压缩丢弃可接受（竞选仅 day 1） */
      if (ev.kind === 'elected') parts.push(`${ev.seat} 号当选警长`);
      else if (ev.kind === 'transfer') parts.push(`警徽移交给 ${ev.to} 号`);
      else if (ev.kind === 'destroy') parts.push('警长撕毁警徽');
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
    /* stream:true + 预算钳制：体验通道是思考型模型，只认流式且思考烧 2000+ token
       （800 时代冻结值必空正文，见 shared/prompts.js AI_TOKEN_BUDGET 注释） */
    return { url, body: { model: cfg.model, messages, temperature: 0.7, max_tokens: clampMaxTokens(cfg.maxTokens), stream: true } };
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

/** §5.1 宽容解析：先判竞选二选一关键字与 save / skip，再取第一个 1–9 数字；
 *  失败返回 null（回退）。狼阶段不走此函数（两行格式，见 parseWolfReply）。
 *  §1.3 / §2.6（ADR-0013/0014）扩：guard / elect_* / badge 分支——
 *  竞选发言（elect_campaign / elect_pk_speak）与发言三元组同步扩（裁定 5），
 *  动作走 elect_speak（hElectSpeak 队列）；elect_join 的 run/pass、
 *  elect_withdraw 的 quit/stay 关键字必须先于通用 skip/pass 判定（B3-1：
 *  elect_join 的 pass=不上警与既有 pass=skip 弃票语义撞车）；
 *  badge 的 skip = 撕毁警徽。与 js/ai.js parseReply 双份同口径（ADR-0004）。 */
export function parseAIReply(phase, text) {
  if (typeof text !== 'string') return null;
  if (phase === 'speak' || phase === 'lastwords' || phase === 'pk_speak') {
    const t = clipSpeech(text.trim(), game.SPEECH_MAX); // 硬上限 250 字、按句收尾（§5.8 / ADR-0012）
    return t ? { type: 'speak', text: t } : null;
  }
  if (phase === 'elect_campaign' || phase === 'elect_pk_speak') {
    const t = clipSpeech(text.trim(), game.SPEECH_MAX); // 裁定 5：竞选发言同款截断；动作走 elect_speak
    return t ? { type: 'elect_speak', text: t } : null;
  }
  const s = text.trim().toLowerCase().replace(/[\s.,;:!?，。；：！？、"'`()[\]{}<>《》-]/g, '');
  /* §2.6 竞选二选一关键字（先于通用 skip/pass，B3-1 顺序陷阱） */
  if (phase === 'elect_join') {
    if (s === 'run') return { type: 'elect_run', run: true };
    if (s === 'pass') return { type: 'elect_run', run: false };
    return null;
  }
  if (phase === 'elect_withdraw') {
    if (s === 'quit') return { type: 'elect_withdraw', quit: true };
    if (s === 'stay') return { type: 'elect_withdraw', quit: false };
    return null;
  }
  if (s === 'save') return phase === 'witch' ? { type: 'witch_move', move: 'save' } : null;
  if (s === 'skip' || s === 'pass') {
    if (phase === 'witch') return { type: 'witch_move', move: 'skip' };
    if (phase === 'hunter') return { type: 'hunter_shoot', target: null };
    if (phase === 'vote' || phase === 'pk_vote') return { type: 'vote', target: null };
    if (phase === 'elect_vote') return { type: 'elect_vote', target: null }; // 警长票弃票（§2.3）
    if (phase === 'badge') return { type: 'badge_move', target: null }; // skip = 撕毁警徽（§2.6）
    return null; // wolf / seer / guard 不可 skip（§5.10 / §4.1.2 / §1.3）→ 解析失败走回退
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
    case 'guard':
      return { type: 'guard_protect', target: n }; // §1.3 守卫：座位号，不可跳过
    case 'elect_vote':
      return { type: 'elect_vote', target: n };
    case 'badge':
      return { type: 'badge_move', target: n }; // 座位号 = 移交警徽（§2.6）
    default:
      return null;
  }
}

/**
 * AI 回复 → 可用动作（§5.1 解析 + 内核干跑校验，纯函数不入账）：解析成功但
 * 动作非法（目标已死 / 非队列头 / PK 台外等）与解析失败同罪，都算「未正常
 * 回复符合格式的回复」，由调用方重试 1 次或走确定性回退（§8.4）。
 * wolf 阶段两行格式（密聊 + 刀口）；chat 尽力保留（有话没票时仍可入账）。
 * 返回 { chat, action }：action = null 表示本条回复不可用。
 * 与 js/ai.js decideFor 内的 digestReply 同口径（两边刻意各自持有）。
 */
export function digestAIReply(g, phase, seat, text) {
  const out = { chat: null, action: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  try {
    if (phase === 'wolf') {
      const w = parseWolfReply(text);
      out.chat = w.chat;
      if (w.target == null) return out;
      const action = { type: 'wolf_target', seat, target: w.target };
      if (game.advance(g, action).error) return out;
      out.action = action;
      return out;
    }
    const parsed = parseAIReply(phase, text);
    if (!parsed) return out;
    const action = { ...parsed, seat };
    if (game.advance(g, action).error) return out;
    out.action = action;
    return out;
  } catch (e) {
    return out;
  }
}

/* ---------- sweep（DO alarm：托管 / 行动超时 / 全员失联作废，§7.7 + §4.1，ADR-0016） ---------- */

/**
 * 时钟驱动的房间巡检（纯函数，DO alarm 与每次请求后可调）：
 *   1. 真人 >60s 无心跳 → 转托管（联机，真人 >1）；
 *   2. 行动超时 150s → 确定性回退推进 + 该座位转托管（§5.11）；
 *   3. 全员（任何真人）失联 >30min → 房间作废（§4.1 作废口径修订，ADR-0016；
 *      房主早掉线而他人仍在时游戏由服务端闹钟接管继续，不作废）；
 *   4. 房主在线翻转（35s 窗口，仍按房主本人心跳——ownerOnline 语义是
 *      「房主在线」，serverDrive 与文案都依赖它，不随作废口径一并改）。
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
  if (now - latestHumanSeen(draft, g) > OWNER_ABANDON_MS) {
    draft.abandoned = true; // §4.1（ADR-0016）全员失联 30min 作废只读；作废文案不变
    changed = true;
  } else {
    const ownerSeen = draft.heartbeats[draft.ownerUid] ?? draft.createdAt;
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

/** 下一次 alarm 时刻；null = 无需计时。
 *  §4.1（ADR-0016）：alarmDriveDue 满足时推 now + AI_DRIVE_CADENCE_MS——
 *  alarm 以 5s 节拍持续重排，直到房主回归或游戏结束；作废分量连根改
 *  latestHumanSeen（裁定 8：旧公式 ownerSeen+30min 在房主久掉线而他人在线时
 *  算出过去时刻，被 max(now+1) 钳成毫秒级热循环烧 CF alarm 配额）。 */
export function nextAlarmAt(room, now) {
  const g = room.game;
  if (room.abandoned || (g.phase !== 'night' && g.phase !== 'day')) return null;
  const times = [];
  if (room.deadline) times.push(room.deadline.at);
  if (HUMANS(g) > 1) {
    const ownerSeen = room.heartbeats[room.ownerUid] ?? room.createdAt;
    if (room.ownerOnline) times.push(ownerSeen + ONLINE_WINDOW_MS); // 房主掉线检测（ownerOnline 翻转点）
    times.push(latestHumanSeen(room, g) + OWNER_ABANDON_MS); // §4.1 作废分量（全员失联口径，裁定 8）
    for (const p of g.players) {
      if (!p || p.isAI || !p.alive || room.hosted.includes(p.seat)) continue;
      times.push((room.heartbeats[p.uid] ?? room.createdAt) + HOST_AFTER_MS);
    }
    if (alarmDriveDue(room, now)) times.push(now + AI_DRIVE_CADENCE_MS); // 闹钟接管节拍（门在 HUMANS>1 内，单机恒 null）
  }
  if (!times.length) return null;
  return Math.max(now + 1, Math.min(...times));
}
