/* ============================================================
 * shared/game.js —— 共享游戏内核（单份纯函数，零 I/O）
 * ------------------------------------------------------------
 * 消费方：worker/src/room.js（DO 权威执行）与 js/app.js（渲染），
 *   根 package.json "type":"module"，原生 ESM 共用（ADR-0001）。
 *   本文件不允许出现 DOM / fetch / storage / Date / Math.random。
 * 口径唯一真相源：docs/features.md（冻结版）§3–§5 / §7 / §8.4。
 *
 * 纯函数契约：
 *   advance(state, action) → { state, events, error }
 *     - 不修改入参 state（内部 structuredClone）；成功时返回新状态。
 *     - 校验不过：error 为字符串，state 原样返回（同一引用），
 *       events 为空。DO 对重复 / 越权提交得到的 error 直接忽略即幂等（§2）。
 *     - events 是本次动作产生的**公开事件**（§8.1 公开历史）：
 *       join / ready / game_start / day_announce（死讯公告，暗牌）/
 *       last_words / speech / pk_speech / vote（逐人投票去向）/
 *       vote_result（放逐结果或平票 PK 或平安日）/ hunter_flip /
 *       hunter_shoot / hunter_skip / game_over。
 *       夜间子阶段不产生任何公开事件（§4.1.5），私有信息只写入
 *       state（seerChecks / witch / night.blade），由 DO 按座位裁剪快照。
 *
 * 状态（全部 JSON 可序列化，DO 直接落 SQLite）：
 *   phase: 'lobby' | 'night' | 'day' | 'revealed'
 *   subPhase: 夜 'wolf'|'seer'|'witch'；昼 'night_hunter'|'lastwords'|
 *     'speak'|'vote'|'pk_speak'|'pk_vote'|'exile_lastwords'|'hunter'
 *   players[9]: { seat, nick, uid, isAI, ready, role, alive, death? }
 *     death = { day, cause: 'blade'|'poison'|'shot'|'exile' }（复盘用）
 *   rng: mulberry32 状态（发牌洗牌与确定性回退共用，测试可复现）
 *   night: 当夜瞬时 { blade, saved, poison, wolfChat, wolfVotes }，天亮结算后清空
 *     （wolfChat = 狼队密聊记录、wolfVotes = 狼队定刀投票，仅狼座快照可见，§4.1.5）
 *   seerChecks / witch / queue / votes / pkCandidates / pendingHunter /
 *   pendingExile / winner / reason
 * ============================================================ */

export const SEAT_COUNT = 9; // §3：房间人数固定 9，不可设置
export const MIN_HUMANS = 3; // §7.4：最小开桌真人 3 人
export const BOARD = { werewolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1 }; // §3 唯一板子
const SPEECH_MAX = 200; // §5.8：发言 / 遗言 ≤200 字（内核同 UI 双重限制）
export const WOLF_CHAT_MAX = 60; // §4.1.1：狼队密聊每条 ≤60 字
export const WOLF_CHAT_TURNS = 5; // §4.1.1：每晚每狼至多 5 条（防刷屏防状态膨胀）

/* ---------- 内部工具 ---------- */

const clone = (s) => structuredClone(s);
const fail = (state, msg) => ({ state, events: [], error: msg });
const ok = (s, events = []) => ({ state: s, events, error: null });

function bySeat(s, seat) {
  return Number.isInteger(seat) && seat >= 1 && seat <= SEAT_COUNT ? s.players[seat - 1] : null;
}
function isAlive(s, seat) {
  const p = bySeat(s, seat);
  return p && p.alive ? p : null;
}
function aliveSeats(s) {
  return s.players.filter((p) => p && p.alive).map((p) => p.seat);
}
function findAliveRole(s, role) {
  return s.players.find((p) => p && p.alive && p.role === role) || null;
}

/* ---------- 种子随机（mulberry32，可复现） ---------- */
// ponytail: 取模取下标存在 <2^-32 级偏差，9 个元素的洗牌可忽略；
// 需要密码学随机时由 DO 传入 crypto 种子即可，内核不引入 WebCrypto。

function nextU32(rng) {
  rng = (rng + 0x6d2b79f5) | 0;
  let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [(t ^ (t >>> 14)) >>> 0, rng];
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const [v, r] = nextU32(rng);
    rng = r;
    const j = v % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return [a, rng];
}

function pick(list, rng) {
  const [v, r] = nextU32(rng);
  return [list[v % list.length], r];
}

/* ---------- 状态构造 ---------- */

export function createInitialState() {
  return {
    phase: 'lobby',
    day: 0,
    subPhase: null,
    players: new Array(SEAT_COUNT).fill(null), // players[i] = 座位 i+1
    rng: 0,
    night: null,
    seerChecks: [], // 预言家私有：[{ night, target, isWolf }]
    witch: null, // 女巫私有：{ antidote, poison } 各 1 瓶全局（§5.2）
    queue: [], // lastwords / speak / pk_speak 待处理座位，顺序执行
    votes: null, // { round: 'main'|'pk', cast: { 座位: 目标|null } }
    pkCandidates: null,
    pendingHunter: null, // 待开枪的猎人座位（夜死或被放逐）
    pendingExile: null, // 待遗言的被放逐者座位
    winner: null,
    reason: null,
  };
}

/* ---------- 导出的规则纯函数 ---------- */

/** §5.1 狼队长（定刀平票时的一锤定音者）：存活狼真人优先（多人取座位号最小），否则座位号最小 AI 狼。 */
export function wolfCaptain(state) {
  const wolves = state.players.filter((p) => p && p.alive && p.role === 'werewolf');
  if (wolves.length === 0) return null;
  const humans = wolves.filter((p) => !p.isAI);
  const pool = humans.length > 0 ? humans : wolves;
  return pool.reduce((m, p) => (p.seat < m.seat ? p : m)).seat;
}

/** §5.7 胜负（屠城制）：狼存活数 = 0 → 好人胜；狼 ≥ 非狼 → 狼胜。 */
export function checkWinner(state) {
  let wolves = 0;
  let others = 0;
  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (p.role === 'werewolf') wolves += 1;
    else others += 1;
  }
  if (wolves === 0) return { winner: 'good', reason: 'wolves-eliminated' };
  if (wolves >= others) return { winner: 'wolf', reason: 'parity' };
  return null;
}

/** §4.1.3 / §5.2 女巫看刀口：仅女巫行动子阶段、解药未用时可见。 */
export function witchSeesBlade(state) {
  if (state.phase !== 'night' || state.subPhase !== 'witch' || !state.night) return null;
  const witch = findAliveRole(state, 'witch');
  if (!witch || state.witch.antidote <= 0) return null; // 解药耗尽后不再显示刀口
  return state.night.blade;
}

/**
 * §7.4 / §7.5 AI 补位：空座位按座位升序补 AI，昵称 AI-1…AI-8 按
 * 补位顺序分配（昵称即公开标识是 AI）。纯函数，供 start 与房主确认弹窗预估共用。
 */
export function generateAISeats(players) {
  const seats = [];
  let n = 0;
  for (let i = 0; i < players.length; i++) {
    if (players[i]) continue;
    n += 1;
    seats.push({ seat: i + 1, nick: `AI-${n}`, uid: `ai:${i + 1}`, isAI: true, ready: true, role: null, alive: true });
  }
  return seats;
}

/** 当前待行动座位（UI 提示「轮到你」与 DO 150s 超时兜底共用；投票阶段返回首个未投者）。 */
export function pendingSeat(state) {
  switch (`${state.phase}:${state.subPhase}`) {
    case 'night:wolf': {
      // 狼队全员投票制：待行动 = 第一个未投票的存活狼（超时与 AI 驱动按此逐个推进；
      // 全部投完的瞬间 hWolfTarget 已推进到下一子阶段，不会停留在此）
      const votes = wolfVotesOf(state);
      const w = state.players.find(
        (p) => p && p.alive && p.role === 'werewolf' && votes[p.seat] === undefined
      );
      return w ? w.seat : null;
    }
    case 'night:seer': {
      const p = findAliveRole(state, 'seer');
      return p ? p.seat : null;
    }
    case 'night:witch': {
      const p = findAliveRole(state, 'witch');
      return p ? p.seat : null;
    }
    case 'day:night_hunter':
    case 'day:hunter':
      return state.pendingHunter;
    case 'day:lastwords':
    case 'day:exile_lastwords':
    case 'day:speak':
    case 'day:pk_speak':
      return state.queue.length > 0 ? state.queue[0] : null;
    case 'day:vote':
    case 'day:pk_vote': {
      if (!state.votes) return null;
      return aliveSeats(state).find((seat) => state.votes.cast[seat] === undefined) ?? null;
    }
    default:
      return null;
  }
}

/* ---------- 动作分发 ---------- */

export function advance(state, action) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return fail(state, '无效状态');
  if (!action || typeof action !== 'object') return fail(state, '无效动作');
  const h = HANDLERS[action.type];
  if (!h) return fail(state, `未知动作类型：${String(action.type)}`);
  return h(state, action);
}

const HANDLERS = {
  join: hJoin,
  ready: hReady,
  start: hStart,
  wolf_chat: hWolfChat,
  wolf_target: hWolfTarget,
  seer_check: hSeerCheck,
  witch_move: hWitchMove,
  hunter_shoot: hHunterShoot,
  speak: hSpeak, // 覆盖白天发言 / PK 发言 / 遗言（§9 动作只有 speak，按 subPhase 区分）
  vote: hVote, // 覆盖主投票 / PK 投票
};

/* ---------- 大厅 ---------- */

function hJoin(state, a) {
  const s = clone(state);
  if (s.phase !== 'lobby') return fail(state, '房间已开局，不能加入'); // 中途加入是非目标 §13.5
  const nick = typeof a.nick === 'string' ? a.nick.trim() : '';
  if (!nick) return fail(state, '昵称不能为空');
  if (a.uid == null) return fail(state, '缺少 uid');
  if (s.players.some((p) => p && p.uid === a.uid)) return fail(state, '该 uid 已在房间内');
  const idx = s.players.findIndex((p) => p === null);
  if (idx < 0) return fail(state, '房间已满');
  const seat = idx + 1;
  s.players[idx] = { seat, nick, uid: a.uid, isAI: false, ready: false, role: null, alive: true };
  return ok(s, [{ type: 'join', seat, nick }]);
}

function hReady(state, a) {
  const s = clone(state);
  if (s.phase !== 'lobby') return fail(state, '房间已开局');
  const p = bySeat(s, a.seat);
  if (!p || p.isAI) return fail(state, '座位不存在');
  if (a.ready !== true && a.ready !== false) return fail(state, 'ready 必须为布尔值');
  p.ready = a.ready;
  return ok(s, [{ type: 'ready', seat: p.seat, ready: a.ready }]);
}

function hStart(state, a) {
  const s = clone(state);
  if (s.phase !== 'lobby') return fail(state, '游戏已开始，不能重复开局');
  if (!Number.isInteger(a.seed)) return fail(state, '缺少发牌种子 seed（DO 用 crypto 随机数传入）');
  const humans = s.players.filter((p) => p && !p.isAI);
  /* §6 单机 = 1 真人 + 8 AI：浏览器本地开局传 solo:true 放宽最小开桌数（ADR-0003）。
   * DO 路由（worker/src/room-logic.js applyAction 'start'）不下发 solo 字段，
   * 联机仍按 §7.4 最少 3 真人，行为不变。 */
  const minHumans = a.solo === true ? 1 : MIN_HUMANS;
  if (humans.length < minHumans) return fail(state, `真人不足 ${MIN_HUMANS} 人，无法开桌`); // §7.4 最小开桌数
  if (humans.some((p) => !p.ready)) return fail(state, '仍有真人未准备'); // §7.4 start 时重校验
  for (const ai of generateAISeats(s.players)) s.players[ai.seat - 1] = ai; // 补位到 9
  // §3 开局均匀随机洗牌发牌（带种子，测试可复现）
  const deck = [];
  for (const [role, n] of Object.entries(BOARD)) for (let i = 0; i < n; i++) deck.push(role);
  const [dealt, rng] = shuffle(deck, a.seed | 0);
  s.rng = rng;
  s.players.forEach((p, i) => {
    p.role = dealt[i];
  });
  s.phase = 'night';
  s.day = 1;
  s.subPhase = 'wolf';
  s.night = { blade: null, saved: false, poison: null, wolfChat: [], wolfVotes: {} };
  s.witch = { antidote: 1, poison: 1 };
  s.seerChecks = [];
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  return ok(s, [
    { type: 'game_start', day: 1, players: s.players.map((p) => ({ seat: p.seat, nick: p.nick, isAI: p.isAI })) }, // 不含 role，暗牌
  ]);
}

/* ---------- 夜晚（§4.1：狼队密聊+投票定刀 → seer → witch → 结算） ---------- */

/**
 * §4.1.1 狼队密聊：仅存活狼人可见的夜间频道（night.wolfChat，天亮即清）。
 * 不产生公开事件（§4.1.5）；每狼每晚至多 WOLF_CHAT_TURNS 条、每条 ≤WOLF_CHAT_MAX 字。
 */
function hWolfChat(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'wolf') return fail(state, '当前不是狼队密聊时间');
  // 部署过渡兜底：旧版持久化房间的 night 没有这两个字段，推进前补齐
  if (!Array.isArray(s.night.wolfChat)) s.night.wolfChat = [];
  if (!s.night.wolfVotes || typeof s.night.wolfVotes !== 'object') s.night.wolfVotes = {};
  const me = isAlive(s, a.seat);
  if (!me || me.role !== 'werewolf') return fail(state, '只有存活狼人可以参与密聊');
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text) return fail(state, '密聊内容不能为空');
  if (text.length > WOLF_CHAT_MAX) return fail(state, `密聊每条不超过 ${WOLF_CHAT_MAX} 字`);
  if (s.night.wolfChat.filter((m) => m.seat === a.seat).length >= WOLF_CHAT_TURNS) {
    return fail(state, `今晚你的密聊条数已用完（${WOLF_CHAT_TURNS} 条）`);
  }
  s.night.wolfChat.push({ seat: a.seat, text });
  return ok(s);
}

/**
 * §4.1.1 投票定刀：每个存活狼人一票（不可改票），目标必须是存活玩家
 * （允许投队友 / 自己——自刀与弃车是合法战术，§8.4 同口径）。
 * 全部存活狼投完的瞬间结算：最高票出局，平票由狼队长一锤定音。
 */
function hWolfTarget(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'wolf') return fail(state, '当前不是狼人定刀阶段');
  // 部署过渡兜底：旧版持久化房间的 night 没有投票表，推进前补齐
  if (!s.night.wolfVotes || typeof s.night.wolfVotes !== 'object') s.night.wolfVotes = {};
  const me = isAlive(s, a.seat);
  if (!me || me.role !== 'werewolf') return fail(state, '只有存活狼人可以投票定刀');
  if (s.night.wolfVotes[a.seat] !== undefined) return fail(state, '你已投过票，不可更改');
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '刀口必须是存活玩家（狼不可空刀，§5.10）');
  s.night.wolfVotes[a.seat] = t.seat;
  const unvoted = s.players.some(
    (p) => p && p.alive && p.role === 'werewolf' && s.night.wolfVotes[p.seat] === undefined
  );
  if (unvoted) return ok(s); // 还有队友未投票，继续等（密聊仍开放）
  return resolveWolfVote(s);
}

/** 狼票结算：最高票出局；平票时狼队长的票若在平票集合中则从其票，否则取最小座位号。 */
function resolveWolfVote(s) {
  const counts = new Map();
  for (const t of Object.values(s.night.wolfVotes)) counts.set(t, (counts.get(t) || 0) + 1);
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  const top = [...counts.keys()].filter((seat) => counts.get(seat) === max).sort((x, y) => x - y);
  let blade = top[0];
  if (top.length > 1) {
    const capVote = s.night.wolfVotes[wolfCaptain(s)];
    if (capVote != null && top.includes(capVote)) blade = capVote;
  }
  s.night.blade = blade;
  return enterSeer(s);
}

/** 待行动座位未投票时的狼票兜底读取（pendingSeat / 快照共用）。 */
function wolfVotesOf(state) {
  return state.night && state.night.wolfVotes && typeof state.night.wolfVotes === 'object'
    ? state.night.wolfVotes
    : {};
}

function enterSeer(s) {
  if (findAliveRole(s, 'seer')) {
    s.subPhase = 'seer';
    return ok(s);
  }
  return enterWitch(s); // 预言家已死 → 跳过
}

function enterWitch(s) {
  const w = findAliveRole(s, 'witch');
  if (w && (s.witch.antidote > 0 || s.witch.poison > 0)) {
    s.subPhase = 'witch';
    return ok(s);
  }
  return settleNight(s); // 女巫已死或双药用尽 → 无事可做，直接结算
}

function hSeerCheck(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'seer') return fail(state, '当前不是预言家验人阶段');
  const seer = findAliveRole(s, 'seer');
  if (a.seat !== seer.seat) return fail(state, '只有预言家可以验人');
  if (a.target === seer.seat) return fail(state, '预言家不能验自己'); // §4.1.2
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '验人目标必须是存活玩家'); // 不得验已死
  s.seerChecks.push({ night: s.day, target: t.seat, isWolf: t.role === 'werewolf' }); // 私有信息
  return enterWitch(s);
}

function hWitchMove(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'witch') return fail(state, '当前不是女巫用药阶段');
  const witch = findAliveRole(s, 'witch');
  if (a.seat !== witch.seat) return fail(state, '只有女巫可以用药');
  if (a.move === 'skip') return settleNight(s);
  if (a.move === 'save') {
    if (s.witch.antidote < 1) return fail(state, '解药已用完');
    if (s.day > 1 && s.night.blade === witch.seat) return fail(state, '首夜之后女巫不可自救'); // §4.1.3
    s.witch.antidote = 0;
    s.night.saved = true;
    return settleNight(s);
  }
  if (a.move === 'poison') {
    if (s.witch.poison < 1) return fail(state, '毒药已用完');
    const t = isAlive(s, a.target);
    if (!t) return fail(state, '毒药目标必须是存活玩家');
    s.witch.poison = 0;
    s.night.poison = t.seat; // 毒目标可与刀口重合（§4.1.4）；规格未禁自毒，允许
    return settleNight(s);
  }
  return fail(state, '女巫动作必须是 save / poison / skip'); // 同晚至多 1 瓶：一次只提交一个动作（§5.2）
}

/** §4.1.4 夜结算：死亡 = 刀口（未被救）∪ 毒目标，可重合（重合死 1 人）。 */
function settleNight(s) {
  const dead = new Set();
  if (s.night.blade !== null && !s.night.saved) dead.add(s.night.blade);
  if (s.night.poison !== null) dead.add(s.night.poison);
  const deadSeats = [...dead].sort((x, y) => x - y);
  const poison = s.night.poison;
  for (const seat of deadSeats) {
    const p = s.players[seat - 1];
    p.alive = false;
    // 死因私有记录（终局复盘用）；毒优先于刀：毒死猎人即使同时被刀也无枪（§5.3）
    p.death = { day: s.day, cause: poison !== null && poison === seat ? 'poison' : 'blade' };
  }
  s.phase = 'day';
  s.night = null; // 天亮清空当夜瞬时信息
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  // §4.2.1 天亮一次性公布全部死者（不区分先后、暗牌）；平安夜 = 刀口被救且无毒
  const events = [{ type: 'day_announce', day: s.day, dead: deadSeats, peaceful: deadSeats.length === 0 }];
  // §4.2.2 可开枪的夜死猎人 = 死于刀口且未死于毒；其翻牌开枪先于遗言
  const hunterSeat = deadSeats.find(
    (seat) => s.players[seat - 1].role === 'hunter' && s.players[seat - 1].death.cause === 'blade'
  );
  if (hunterSeat !== undefined) {
    s.subPhase = 'night_hunter';
    s.pendingHunter = hunterSeat;
    return ok(s, events); // 胜负判定推迟到猎人枪后（§4.2.2 即时判胜负）
  }
  return checkAndEnterDay(s, events, deadSeats); // 无枪 → §4.3 夜结算检查点立即判
}

/** 夜死猎人枪毕 / 无枪时的共同入口：判胜负 → 遗言 / 发言。 */
function checkAndEnterDay(s, events, deadSeats) {
  const w = checkWinner(s);
  if (w) return gameOver(s, events, w); // §4.3 达成立刻 revealed，剩余阶段不再执行
  return enterLastwords(s, events, deadSeats);
}

/** 当夜死于刀 / 毒的座位（被枪杀者不算，无遗言）。 */
function nightDeadSeats(s, day) {
  return s.players
    .filter((p) => p && p.death && p.death.day === day && (p.death.cause === 'blade' || p.death.cause === 'poison'))
    .map((p) => p.seat);
}

/** §4.2.3 遗言：仅首夜夜死有；座位序。 */
function enterLastwords(s, events, deadSeats) {
  if (s.day === 1 && deadSeats.length > 0) {
    s.subPhase = 'lastwords';
    s.queue = deadSeats.slice();
    return ok(s, events);
  }
  return enterSpeak(s, events);
}

/** §4.2.4 发言：从存活最小座位号起，按座位顺序每人 1 条。 */
function enterSpeak(s, events) {
  s.subPhase = 'speak';
  s.queue = aliveSeats(s);
  return ok(s, events);
}

/* ---------- 白天（§4.2） ---------- */

function hHunterShoot(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || (s.subPhase !== 'night_hunter' && s.subPhase !== 'hunter')) {
    return fail(state, '当前不是猎人开枪阶段');
  }
  if (a.seat !== s.pendingHunter) return fail(state, '只有触发翻牌的猎人可以开枪');
  const hunter = s.players[s.pendingHunter - 1];
  const events = [{ type: 'hunter_flip', day: s.day, seat: hunter.seat }]; // 翻牌 = 唯一亮身份时机（§5.5）
  if (a.target === null || a.target === undefined) {
    events.push({ type: 'hunter_skip', day: s.day, seat: hunter.seat }); // 可放弃开枪（§5.6）
    return afterHunter(s, events);
  }
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '枪目标必须是存活玩家');
  t.alive = false;
  t.death = { day: s.day, cause: 'shot' }; // 被枪杀者无遗言、不翻牌（§4.2.2 / §5.4）
  events.push({ type: 'hunter_shoot', day: s.day, seat: hunter.seat, target: t.seat }); // 枪杀 = 追加公布
  return afterHunter(s, events); // 内含枪后立即再判胜负（§5.6）
}

function afterHunter(s, events) {
  const w = checkWinner(s);
  if (w) return gameOver(s, events, w);
  if (s.subPhase === 'night_hunter') {
    // 夜亡猎人枪毕 → 遗言（首夜，含猎人本人，§4.2.3「夜死猎人在第 2 步后」）或直接发言
    return enterLastwords(s, events, nightDeadSeats(s, s.day));
  }
  // 被放逐猎人枪毕 → 放逐检查点（§4.2.8）→ 下一夜
  return checkAndNextNight(s, events);
}

const SPEAK_SUBS = ['lastwords', 'exile_lastwords', 'speak', 'pk_speak'];

function hSpeak(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || !SPEAK_SUBS.includes(s.subPhase)) return fail(state, '当前不是可发言阶段');
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text) return fail(state, '发言不能为空');
  if (text.length > SPEECH_MAX) return fail(state, `发言不得超过 ${SPEECH_MAX} 字`);
  const seat = s.queue.length > 0 ? s.queue[0] : undefined;
  if (seat === undefined || a.seat !== seat) return fail(state, '还没轮到该座位发言'); // 严格座位顺序，不可跳过
  s.queue.shift();
  const etype = s.subPhase === 'speak' ? 'speech' : s.subPhase === 'pk_speak' ? 'pk_speech' : 'last_words';
  const events = [{ type: etype, day: s.day, seat, text }];
  if (s.queue.length > 0) return ok(s, events);
  switch (s.subPhase) {
    case 'speak':
      return enterVote(s, events, 'main');
    case 'pk_speak':
      return enterVote(s, events, 'pk');
    case 'lastwords':
      return enterSpeak(s, events);
    case 'exile_lastwords':
      return finishExile(s, events);
  }
}

function enterVote(s, events, round) {
  s.subPhase = round === 'main' ? 'vote' : 'pk_vote';
  s.votes = { round, cast: {} }; // pk 候选人沿用 s.pkCandidates（平票时写入）
  return ok(s, events);
}

function hVote(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || (s.subPhase !== 'vote' && s.subPhase !== 'pk_vote')) return fail(state, '当前不是投票阶段');
  const p = isAlive(s, a.seat);
  if (!p) return fail(state, '只有存活玩家可以投票'); // 1 人 1 票
  if (s.votes.cast[a.seat] !== undefined) return fail(state, '该座位已投过票'); // DO 层对重复提交忽略即幂等
  const target = a.target === undefined ? null : a.target;
  if (target !== null) {
    const t = isAlive(s, target);
    if (!t) return fail(state, '投票目标必须是存活玩家');
    if (s.votes.round === 'pk' && !s.pkCandidates.includes(target)) {
      return fail(state, 'PK 投票只能投 PK 台上的玩家'); // §4.2.6
    }
  }
  s.votes.cast[a.seat] = target;
  const events = [{ type: 'vote', day: s.day, round: s.votes.round, seat: a.seat, target }]; // 逐人去向公开（§5.9）
  const pending = aliveSeats(s).filter((seat) => s.votes.cast[seat] === undefined);
  if (pending.length > 0) return ok(s, events);
  return tally(s, events);
}

function tally(s, events) {
  const round = s.votes.round;
  const counts = new Map();
  for (const t of Object.values(s.votes.cast)) if (t !== null) counts.set(t, (counts.get(t) || 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const tallyList = [...counts.entries()]
    .map(([seat, count]) => ({ seat, count }))
    .sort((x, y) => y.count - x.count || x.seat - y.seat);
  if (total === 0) {
    // §5.9 全弃票等同平票 → 无人出局（无候选者可 PK，直接平安日）
    // ponytail: 「等同平票」按结果口径直出平安日；若要拉 PK 台需先改 features.md。
    events.push({ type: 'vote_result', day: s.day, round, tally: [], exiled: null, peaceful: true, reason: 'all-abstain' });
    s.votes = null;
    return checkAndNextNight(s, events);
  }
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  const top = [...counts.keys()]
    .filter((seat) => counts.get(seat) === max)
    .sort((x, y) => x - y);
  if (round === 'main' && top.length > 1) {
    // §4.2.6 平票 → 平票者 pk_speak（各 1 条）→ pk_vote
    events.push({ type: 'vote_result', day: s.day, round, tally: tallyList, exiled: null, pk: top });
    s.pkCandidates = top;
    s.subPhase = 'pk_speak';
    s.queue = top.slice();
    s.votes = null;
    return ok(s, events);
  }
  if (top.length > 1) {
    // PK 再平（全弃已在 total=0 覆盖）→ 无人出局（平安日）
    events.push({ type: 'vote_result', day: s.day, round, tally: tallyList, exiled: null, peaceful: true, reason: 'pk-tie' });
    s.votes = null;
    s.pkCandidates = null;
    return checkAndNextNight(s, events);
  }
  return doExile(s, events, top[0], tallyList);
}

function doExile(s, events, seat, tallyList) {
  const p = s.players[seat - 1];
  p.alive = false;
  p.death = { day: s.day, cause: 'exile' };
  events.push({ type: 'vote_result', day: s.day, round: s.votes.round, tally: tallyList, exiled: seat }); // 放逐结果，暗牌
  s.votes = null;
  s.pkCandidates = null;
  s.pendingExile = seat;
  s.subPhase = 'exile_lastwords'; // §4.2.6 被放逐者遗言（任何天数都有，§5.4）
  s.queue = [seat];
  return ok(s, events);
}

function finishExile(s, events) {
  const p = s.players[s.pendingExile - 1];
  s.pendingExile = null;
  if (p.role === 'hunter') {
    s.subPhase = 'hunter'; // §4.2.7 被放逐猎人翻牌开枪（先遗言后翻牌，§4.2.6 → §4.2.7）
    s.pendingHunter = p.seat;
    return ok(s, events);
  }
  return checkAndNextNight(s, events); // §4.2.8 放逐检查点
}

function checkAndNextNight(s, events) {
  const w = checkWinner(s);
  if (w) return gameOver(s, events, w);
  return nextNight(s, events);
}

function nextNight(s, events) {
  s.day += 1;
  s.phase = 'night';
  s.subPhase = 'wolf';
  s.night = { blade: null, saved: false, poison: null, wolfChat: [], wolfVotes: {} };
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  return ok(s, events); // 夜里不产生公开消息（§4.1.5）
}

function gameOver(s, events, w) {
  s.phase = 'revealed';
  s.subPhase = null;
  s.winner = w.winner;
  s.reason = w.reason;
  s.night = null;
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  events.push({ type: 'game_over', day: s.day, winner: w.winner, reason: w.reason });
  return ok(s, events);
}

/* ---------- 确定性回退（§8.4 / §5.11：DO 150s 超时与客户端 AI 失败共用同一份） ---------- */

const FALLBACK_LINES = [
  '我先听听大家的意见。',
  '这轮信息不多，我先保留判断。',
  '我先过，看看后面的发言再说。',
  '目前没有特别的线索，先不站边。',
];

/**
 * 对「当前待行动座位」执行确定性回退并推进游戏。
 * 纯函数：同 state 同结果（随机项走 state.rng）。
 * 调用方传 game.pendingSeat(state) 对应座位；座位不符时由 advance 校验拒绝。
 */
export function applyFallback(state, seat) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return fail(state, '无效状态');
  const actor = state.players && state.players[seat - 1];
  if (!actor) return fail(state, '回退座位不存在');
  // 注意：遗言 / 猎人开枪阶段的待行动座位已死亡，故此处不做存活检查；
  // 谁有权行动由 advance 内部校验（发言看队列头、投票要求存活、夜行动看角色）。
  const s = clone(state);
  let action = null;
  switch (`${s.phase}:${s.subPhase}`) {
    case 'day:lastwords':
    case 'day:exile_lastwords':
    case 'day:speak':
    case 'day:pk_speak':
      action = { type: 'speak', seat, text: FALLBACK_LINES[seat % FALLBACK_LINES.length] }; // 固定兜底句，按座位轮换
      break;
    case 'night:wolf': {
      const [t, rng] = pick(aliveSeats(s), s.rng); // 随机存活玩家，含狼队友与自刀（§8.4 战术合法）
      s.rng = rng;
      action = { type: 'wolf_target', seat, target: t };
      break;
    }
    case 'night:seer': {
      const checked = new Set(s.seerChecks.map((c) => c.target));
      let pool = aliveSeats(s).filter((x) => x !== seat && !checked.has(x)); // 随机未验过的存活玩家，排除自己
      if (pool.length === 0) pool = aliveSeats(s).filter((x) => x !== seat); // 全验过则任选（规格未定义的角落）
      const [t, rng] = pick(pool, s.rng);
      s.rng = rng;
      action = { type: 'seer_check', seat, target: t };
      break;
    }
    case 'night:witch':
      return advance(s, { type: 'witch_move', seat, move: 'skip' }); // 女巫回退 = 跳过
    case 'day:night_hunter':
    case 'day:hunter':
      return advance(s, { type: 'hunter_shoot', seat, target: null }); // 猎人回退 = 不开枪
    case 'day:vote':
    case 'day:pk_vote': {
      let pool = s.subPhase === 'pk_vote' ? s.pkCandidates : aliveSeats(s);
      pool = pool.filter((x) => x !== seat); // 随机存活者，不投自己
      if (pool.length === 0) return advance(s, { type: 'vote', seat, target: null }); // 只剩自己可投 → 弃票
      const [t, rng] = pick(pool, s.rng);
      s.rng = rng;
      action = { type: 'vote', seat, target: t };
      break;
    }
    default:
      return fail(state, `座位 ${seat} 当前无需行动，无回退`);
  }
  return advance(s, action);
}
