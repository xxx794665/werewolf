/* ============================================================
 * shared/game.js —— 共享游戏内核（单份纯函数，零 I/O）
 * ------------------------------------------------------------
 * 消费方：worker/src/room.js（DO 权威执行）与 js/app.js（渲染），
 *   根 package.json "type":"module"，原生 ESM 共用（ADR-0001）。
 *   本文件不允许出现 DOM / fetch / storage / Date / Math.random。
 * 口径唯一真相源：docs/features.md（冻结版）§3–§5 / §7 / §8.4；
 *   板子与三新角色（狼王 / 守卫 / 白痴）按 ADR-0013 扩展，警长系统按 ADR-0014 扩展。
 *
 * 纯函数契约：
 *   advance(state, action) → { state, events, error }
 *     - 不修改入参 state（内部 structuredClone）；成功时返回新状态。
 *     - 校验不过：error 为字符串，state 原样返回（同一引用），
 *       events 为空。DO 对重复 / 越权提交得到的 error 直接忽略即幂等（§2）。
 *     - events 是本次动作产生的**公开事件**（§8.1 公开历史）：
 *       join / ready / game_start / day_announce（死讯公告，暗牌）/
 *       last_words / speech / pk_speech / vote（逐人投票去向）/
 *       vote_result（放逐结果或平票 PK 或平安日；白痴板带可选 idiot 免死标记，ADR-0013）/
 *       hunter_flip / hunter_shoot / hunter_skip（狼王翻牌带可选 role:'wolfking'，
 *       缺省省略按 hunter 渲染，向后兼容旧日志，ADR-0013）/
 *       elect_run / elect_speech / elect_withdraw / elect_vote /
 *       sheriff_result（警长竞选结论，kind: elected|none|no-voters|tie-pk，ADR-0014）/
 *       badge_move（警徽移交 / 撕毁，{ day, from, to|null }，ADR-0014）/ game_over。
 *       夜间子阶段不产生任何公开事件（§4.1.5），私有信息只写入
 *       state（seerChecks / witch / guard / night.blade），由 DO 按座位裁剪快照。
 *
 * 状态（全部 JSON 可序列化，DO 直接落 SQLite）：
 *   phase: 'lobby' | 'night' | 'day' | 'revealed'
 *   subPhase: 夜 'wolf'|'guard'|'seer'|'witch'；昼 'night_hunter'|'lastwords'|
 *     'elect_join'|'elect_withdraw'|'elect_campaign'|'elect_vote'|
 *     'elect_pk_speak'|'elect_pk_vote'|'badge'|'speak'|'vote'|'pk_speak'|
 *     'pk_vote'|'exile_lastwords'|'hunter'
 *   board / seed: 板子 id 与发牌种子（hStart 落账，ADR-0013；存档 / 回放 / 测试复现用）
 *   players[9]: { seat, nick, uid, isAI, ready, role, alive, death?, persona?, idiotRevealed? }
 *     role ∈ BOARDS 各板 roles 键（狼王 / 守卫 / 白痴随板子登场，ADR-0013）
 *     death = { day, cause: 'blade'|'poison'|'shot'|'exile' }（复盘用）
 *     idiotRevealed = 白痴被放逐翻牌标记（ADR-0013：免死、失去投票权、保留发言权）
 *     persona = AI 座位的言行风格描述（开局名册抽取，shared/roster.js；
 *     只进 AI 提示词，快照按座位裁剪后不透出，ADR-0009）
 *   rng: mulberry32 状态（发牌洗牌与确定性回退共用，测试可复现）
 *   night: 当夜瞬时 { blade, saved, poison, wolfVotes, guardTarget }，天亮结算后清空
 *     （wolfVotes = 狼队定刀投票，仅狼座快照可见，§4.1.5；
 *      guardTarget = 守卫今晚守护座位，ADR-0013 奶穿结算用）
 *   guard: { last } 守卫持久私有态——上一晚守护座位，不可连守（跨夜保留，ADR-0013）
 *   sheriff: { seat, election, electDone } 警长（ADR-0014）——seat 全程公开、终局保留；
 *     election = day 1 竞选瞬态 { stage, run, candidates, quit, votes, queue, pkCandidates }
 *   badge: { pending, next } 警徽待处置标记——死亡落账处（settleNight 死亡循环 /
 *     doExile / hHunterShoot 枪杀目标）即时置 { pending, next: null }，三个闸口
 *     （enterDayFlow 入口 next='day' / finishExile 遗言后 next='exile' /
 *     checkAndNextNight 入口 next='night'）拦截时补 next 并切 subPhase 'badge'
 *   wolfChatLog: 狼队密聊全程日志 [{ n, seat, text }]，跨夜保留不清空，
 *     仅存活狼座可见、白天可回看（§4.1.1 修订口径；n = 第几夜，与 seerChecks.n 同口径）
 *   seerChecks / witch / queue / votes / pkCandidates / pendingHunter /
 *   pendingExile / winner / reason
 * ============================================================ */

export const SEAT_COUNT = 9; // §3：房间人数固定 9，不可设置
export const MIN_HUMANS = 3; // §7.4：最小开桌真人 3 人
/* §3 四板注册表（ADR-0013；原单板常量 BOARD 已删除，发牌牌堆改由 BOARDS[board].roles 展开）。
 * 各板 roles 合计恒 9（§3 人数不变）；name/intro 供板子选择 UI 展示。 */
export const BOARDS = {
  standard: { name: '标准板', intro: '经典 9 人局：3 狼 3 民，预言家 / 女巫 / 猎人。',
              roles: { werewolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1 } },
  wolfking: { name: '狼王板', intro: '狼王藏在狼队里：被放逐时可翻牌带走一人。',
              roles: { werewolf: 2, wolfking: 1, villager: 3, seer: 1, witch: 1, hunter: 1 } },
  guard:    { name: '守卫板', intro: '守卫每晚守护一人，同守同救会死（奶穿）。',
              roles: { werewolf: 3, villager: 2, seer: 1, witch: 1, hunter: 1, guard: 1 } },
  idiot:    { name: '白痴板', intro: '白痴被放逐时翻牌免死，但失去投票权。',
              roles: { werewolf: 3, villager: 2, seer: 1, witch: 1, hunter: 1, idiot: 1 } },
};
export const DEFAULT_BOARD = 'standard'; // §1.1 缺省板：旧客户端 / 旧房不传 board 时的兼容值
/** §1.2 判狼助手（ADR-0013）：狼王处处视作狼——狼队密聊 / 投票定刀 / 狼队长池 /
 *  胜负 parity / 预言家验人结果全与狼人同口径。 */
export const isWolf = (role) => role === 'werewolf' || role === 'wolfking';
export const SPEECH_MAX = 250; // §5.8：发言 / 遗言硬上限 250 字（提示词目标 100–200，内核 / UI / 解析截断三处同口径；ADR-0012）
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
    night: null, // ADR-0013 裁定 1：night 结构只在 hStart / nextNight 两处构造（guardTarget 随之）
    guard: { last: null }, // §1.3 守卫持久私有态：上一晚守护座位（跨夜保留，连守限制依据）
    sheriff: { seat: null, election: null, electDone: false }, // §2.2 警长（ADR-0014；board/seed 在 hStart 落账）
    badge: null, // 裁定 7：警徽待处置标记 { pending, next }（死亡落账处即时置）
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
  const wolves = state.players.filter((p) => p && p.alive && isWolf(p.role)); // 狼王进队长池（ADR-0013 §1.2）
  if (wolves.length === 0) return null;
  const humans = wolves.filter((p) => !p.isAI);
  const pool = humans.length > 0 ? humans : wolves;
  return pool.reduce((m, p) => (p.seat < m.seat ? p : m)).seat;
}

/** §5.7 胜负（屠城制）：狼存活数 = 0 → 好人胜；狼 ≥ 非狼 → 狼胜。狼王计入狼侧、白痴计入好人侧（ADR-0013）。 */
export function checkWinner(state) {
  let wolves = 0;
  let others = 0;
  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (isWolf(p.role)) wolves += 1;
    else others += 1;
  }
  if (wolves === 0) return { winner: 'good', reason: 'wolves-eliminated' };
  if (wolves >= others) return { winner: 'wolf', reason: 'parity' };
  return null;
}

/** §1.4 / §2.4 投票权（ADR-0013/0014）：存活且非翻牌白痴。
 *  主投票 / PK 投票 / 警长竞选非候选人票同口径（翻牌白痴保留发言权但无票）。 */
export function votersOf(state) {
  return state.players.filter((p) => p && p.alive && !p.idiotRevealed).map((p) => p.seat);
}

/** §4.1.3 / §5.2 女巫看刀口：仅女巫行动子阶段、解药未用时可见。 */
export function witchSeesBlade(state) {
  if (state.phase !== 'night' || state.subPhase !== 'witch' || !state.night) return null;
  const witch = findAliveRole(state, 'witch');
  if (!witch || state.witch.antidote <= 0) return null; // 解药耗尽后不再显示刀口
  return state.night.blade;
}

/**
 * §7.4 / §7.5 AI 补位：空座位按座位升序补 AI。roster（可选）= 开局名册
 * （shared/roster.js 抽取的 { nick, persona? }，worker 接口或 DO 内部抽取），
 * 第 n 条对位第 n 个空座位；缺条目的座位回退默认昵称 AI-n、不带人格
 * （昵称与人格只贴人格池、与身份无关，ADR-0009）。纯函数，供 start 共用。
 */
export function generateAISeats(players, roster) {
  const seats = [];
  let n = 0;
  for (let i = 0; i < players.length; i++) {
    if (players[i]) continue;
    const r = roster && roster[n];
    n += 1;
    seats.push({
      seat: i + 1,
      nick: r && r.nick ? r.nick : `AI-${n}`,
      uid: `ai:${i + 1}`,
      isAI: true,
      ready: true,
      role: null,
      alive: true,
      ...(r && r.persona ? { persona: r.persona } : null),
    });
  }
  return seats;
}

/**
 * §7.5 开局名册校验（start 动作可选字段 roster）：数组，每条 { nick, persona? }。
 * 严进：形状不对直接拒绝开局（调用方 = worker / DO / 本模块自身兜底，是可信
 * 数据源；缺字段回退由 generateAISeats 处理，这里不静默降级）。
 */
function validateRoster(state, roster) {
  if (!Array.isArray(roster)) return fail(state, 'roster 必须是数组');
  if (roster.length > SEAT_COUNT - 1) return fail(state, `roster 最多 ${SEAT_COUNT - 1} 条`);
  const out = [];
  for (let i = 0; i < roster.length; i++) {
    const e = roster[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(state, `roster[${i}] 必须是对象`);
    const nick = typeof e.nick === 'string' ? e.nick.trim() : '';
    if (!nick || nick.length > 20) return fail(state, `roster[${i}].nick 必须是 1–20 字`);
    if (e.persona === undefined) {
      out.push({ nick });
      continue;
    }
    const persona = typeof e.persona === 'string' ? e.persona.trim() : '';
    if (!persona || persona.length > 120) return fail(state, `roster[${i}].persona 必须是 1–120 字`);
    out.push({ nick, persona });
  }
  return out;
}

/** 当前待行动座位（UI 提示「轮到你」与 DO 150s 超时兜底共用；投票阶段返回首个未投者）。 */
export function pendingSeat(state) {
  switch (`${state.phase}:${state.subPhase}`) {
    case 'night:wolf': {
      // 狼队全员投票制：待行动 = 第一个未投票的存活狼（超时与 AI 驱动按此逐个推进；
      // 全部投完的瞬间 hWolfTarget 已推进到下一子阶段，不会停留在此）
      const votes = wolfVotesOf(state);
      const w = state.players.find(
        (p) => p && p.alive && isWolf(p.role) && votes[p.seat] === undefined
      ); // 狼王同投（ADR-0013 §1.2）：漏掉会让定刀永结不了
      return w ? w.seat : null;
    }
    case 'night:guard': {
      // §1.3 守卫守护（ADR-0013）：守卫本人
      const p = findAliveRole(state, 'guard');
      return p ? p.seat : null;
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
    case 'day:elect_join': {
      // §2.3 上警表态（ADR-0014）：首个未表态的存活座
      const el = state.sheriff && state.sheriff.election;
      if (!el) return null;
      return aliveSeats(state).find((seat) => el.run[seat] === undefined) ?? null;
    }
    case 'day:elect_withdraw': {
      // §2.3 退水表态：首个未表态的候选人（非候选人不行动）
      const el = state.sheriff && state.sheriff.election;
      if (!el) return null;
      return el.candidates.find((seat) => el.quit[seat] === undefined) ?? null;
    }
    case 'day:elect_campaign':
    case 'day:elect_pk_speak': {
      const el = state.sheriff && state.sheriff.election;
      return el && el.queue.length > 0 ? el.queue[0] : null;
    }
    case 'day:elect_vote':
    case 'day:elect_pk_vote': {
      // §2.3 警长竞选投票：首个未投的非候选人（投票人含 PK 轮不变）
      const el = state.sheriff && state.sheriff.election;
      if (!el || !el.votes) return null;
      return electionVotersOf(state).find((seat) => el.votes.cast[seat] === undefined) ?? null;
    }
    case 'day:badge':
      // §2.3 警徽处置：死亡警长本人（同遗言死者模式，房主可代提交）
      return state.badge ? state.badge.pending : null;
    case 'day:vote':
    case 'day:pk_vote': {
      if (!state.votes) return null;
      return votersOf(state).find((seat) => state.votes.cast[seat] === undefined) ?? null; // §1.4 翻牌白痴不在待投名单
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
  guard_protect: hGuardProtect, // §1.3 守卫守护（ADR-0013）
  seer_check: hSeerCheck,
  witch_move: hWitchMove,
  hunter_shoot: hHunterShoot,
  speak: hSpeak, // 覆盖白天发言 / PK 发言 / 遗言（§9 动作只有 speak，按 subPhase 区分）
  vote: hVote, // 覆盖主投票 / PK 投票
  elect_run: hElectRun, // §2.3 警长竞选（ADR-0014）
  elect_speak: hElectSpeak,
  elect_withdraw: hElectWithdraw,
  elect_vote: hElectVote,
  badge_move: hBadgeMove, // §2.3 警徽处置
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
  /* §3 / ADR-0013 板子参数：可选 a.board；不在 BOARDS 键内 → 拒绝；
   * 缺省（undefined / null）→ DEFAULT_BOARD，旧客户端 / 旧房兼容行为不变。 */
  const board = a.board === undefined || a.board === null ? DEFAULT_BOARD : a.board;
  if (typeof board !== 'string' || !Object.prototype.hasOwnProperty.call(BOARDS, board)) {
    return fail(state, '未知板子');
  }
  const humans = s.players.filter((p) => p && !p.isAI);
  /* §6 单机 = 1 真人 + 8 AI：浏览器本地开局传 solo:true 放宽最小开桌数（ADR-0003）。
   * DO 路由（worker/src/room-logic.js applyAction 'start'）不下发 solo 字段，
   * 联机仍按 §7.4 最少 3 真人，行为不变。 */
  const minHumans = a.solo === true ? 1 : MIN_HUMANS;
  if (humans.length < minHumans) return fail(state, `真人不足 ${MIN_HUMANS} 人，无法开桌`); // §7.4 最小开桌数
  if (humans.some((p) => !p.ready)) return fail(state, '仍有真人未准备'); // §7.4 start 时重校验
  // §7.5 开局名册（可选）：AI 昵称与人格按补位顺序对位，与发牌身份无关（ADR-0009）
  let roster = null;
  if (a.roster !== undefined && a.roster !== null) {
    roster = validateRoster(state, a.roster);
    if (!Array.isArray(roster)) return roster; // 校验失败 = fail(state, msg)
  }
  for (const ai of generateAISeats(s.players, roster)) s.players[ai.seat - 1] = ai; // 补位到 9
  // §3 开局座位次序随机洗牌（2026-10-05 试玩反馈：真人不再固定 1 号位）：全桌洗一次，
  // 对局内座位号固定不变；用同一 seed 派生相位，发牌链不受影响（同 seed 角色分布不变）
  const [seated] = shuffle(s.players, (a.seed ^ 0x9e3779b9) | 0);
  s.players = seated;
  s.players.forEach((p, i) => { p.seat = i + 1; }); // 洗牌后重写 seat，保持 seat === index + 1 不变式
  // §3 开局均匀随机洗牌发牌（带种子，测试可复现）——牌堆按板子构成展开（ADR-0013）
  const deck = [];
  for (const [role, n] of Object.entries(BOARDS[board].roles)) for (let i = 0; i < n; i++) deck.push(role);
  const [dealt, rng] = shuffle(deck, a.seed | 0);
  s.rng = rng;
  s.players.forEach((p, i) => {
    p.role = dealt[i];
  });
  s.board = board; // §1.1 落账（存档 / 回放 / 快照 / 测试复现用，公开信息）
  s.seed = a.seed; // §1.1 发牌种子落账
  s.phase = 'night';
  s.day = 1;
  s.subPhase = 'wolf';
  // 裁定 1：night 字面量仅 hStart / nextNight 两处，guardTarget 随之构造
  s.night = { blade: null, saved: false, poison: null, wolfVotes: {}, guardTarget: null };
  s.wolfChatLog = []; // §4.1.1 狼队密聊全程日志（跨夜保留，不随天亮清空）
  s.witch = { antidote: 1, poison: 1 };
  s.seerChecks = [];
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  // 新开局字段重置（旧版持久化 lobby 房间无这些字段，开局前补齐——部署过渡兜底同 hWolfChat 口径）
  s.guard = { last: null }; // §1.3 守卫持久态
  s.sheriff = { seat: null, election: null, electDone: false }; // §2.2 警长（ADR-0014）
  s.badge = null; // 裁定 7：警徽待处置标记
  return ok(s, [
    { type: 'game_start', day: 1, players: s.players.map((p) => ({ seat: p.seat, nick: p.nick, isAI: p.isAI })) }, // 不含 role，暗牌
  ]);
}

/* ---------- 夜晚（§4.1 / §1.3：狼队密聊+投票定刀 → 守卫 → 预言家 → 女巫 → 结算） ---------- */

/**
 * §4.1.1 狼队密聊：仅存活狼人可见的夜间频道，写入 wolfChatLog 跨夜保留
 * （白天可回看历史、不能发言）。不产生公开事件（§4.1.5）；
 * 每狼每晚至多 WOLF_CHAT_TURNS 条、每条 ≤WOLF_CHAT_MAX 字。
 */
function hWolfChat(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'wolf') return fail(state, '当前不是狼队密聊时间');
  // 部署过渡兜底：旧版持久化房间 / 旧单机存档没有这个字段，推进前补齐
  if (!Array.isArray(s.wolfChatLog)) s.wolfChatLog = [];
  if (!s.night.wolfVotes || typeof s.night.wolfVotes !== 'object') s.night.wolfVotes = {};
  const me = isAlive(s, a.seat);
  if (!me || !isWolf(me.role)) return fail(state, '只有存活狼人可以参与密聊'); // 狼王可密聊（ADR-0013 §1.2）
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text) return fail(state, '密聊内容不能为空');
  if (text.length > WOLF_CHAT_MAX) return fail(state, `密聊每条不超过 ${WOLF_CHAT_MAX} 字`);
  if (s.wolfChatLog.filter((m) => m.n === s.day && m.seat === a.seat).length >= WOLF_CHAT_TURNS) {
    return fail(state, `今晚你的密聊条数已用完（${WOLF_CHAT_TURNS} 条）`);
  }
  s.wolfChatLog.push({ n: s.day, seat: a.seat, text });
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
  if (!me || !isWolf(me.role)) return fail(state, '只有存活狼人可以投票定刀'); // 狼王同投（ADR-0013 §1.2）
  if (s.night.wolfVotes[a.seat] !== undefined) return fail(state, '你已投过票，不可更改');
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '刀口必须是存活玩家（狼不可空刀，§5.10）');
  s.night.wolfVotes[a.seat] = t.seat;
  const unvoted = s.players.some(
    (p) => p && p.alive && isWolf(p.role) && s.night.wolfVotes[p.seat] === undefined
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
  return enterGuard(s); // §1.3 夜顺序：狼定刀 → 守卫 → 预言家 → 女巫 → 结算（ADR-0013）
}

/** 待行动座位未投票时的狼票兜底读取（pendingSeat / 快照共用）。 */
function wolfVotesOf(state) {
  return state.night && state.night.wolfVotes && typeof state.night.wolfVotes === 'object'
    ? state.night.wolfVotes
    : {};
}

/** §1.3 守卫子阶段入口：存活守卫在场才进入（守卫已死 / 不在板 → 跳过，与 enterSeer/enterWitch 同款跳过模式）。 */
function enterGuard(s) {
  if (findAliveRole(s, 'guard')) {
    s.subPhase = 'guard';
    return ok(s);
  }
  return enterSeer(s);
}

/**
 * §1.3 守卫守护（night:guard，ADR-0013）：守卫本人提交；目标必须存活（可守自己）；
 * 不可与上一晚守护同一人；必须选人（不可空守）。成功后落账 guard.last（持久）与
 * night.guardTarget（瞬态，天亮随 night 清空），进入预言家阶段。
 */
function hGuardProtect(state, a) {
  const s = clone(state);
  if (s.phase !== 'night' || s.subPhase !== 'guard') return fail(state, '当前不是守卫守护阶段');
  const g = findAliveRole(s, 'guard');
  if (a.seat !== g.seat) return fail(state, '只有守卫可以守护');
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '守护目标必须是存活玩家');
  if (t.seat === (s.guard && s.guard.last)) return fail(state, '不可与上一晚守护同一人');
  s.guard.last = t.seat;
  s.night.guardTarget = t.seat;
  return enterSeer(s);
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
  s.seerChecks.push({ night: s.day, target: t.seat, isWolf: isWolf(t.role) }); // 私有信息（验狼王 = 狼，ADR-0013 §1.2）
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

/**
 * §4.1.4 / §1.3（ADR-0013）夜结算——死亡判定（奶穿语义）：
 *   守护且未救 → 活；守护且救 → 死（奶穿，cause='blade'）；未守护且未救 → 死。
 *   毒药无视守护（毒目标恒死）；刀毒重合死 1 人（§4.1.4），毒优先记死因。
 */
function settleNight(s) {
  const dead = new Set();
  const blade = s.night.blade;
  if (blade !== null) {
    // 旧版状态 night 无 guardTarget → undefined 与任何座位不等 → 守护恒 false，语义不变
    const guarded = s.night.guardTarget != null && s.night.guardTarget === blade;
    if (guarded ? s.night.saved : !s.night.saved) dead.add(blade);
  }
  if (s.night.poison !== null) dead.add(s.night.poison); // 毒穿守护恒死
  const deadSeats = [...dead].sort((x, y) => x - y);
  const poison = s.night.poison;
  for (const seat of deadSeats) {
    const p = s.players[seat - 1];
    p.alive = false;
    // 死因私有记录（终局复盘用）；毒优先于刀：毒死猎人即使同时被刀也无枪（§5.3）
    p.death = { day: s.day, cause: poison !== null && poison === seat ? 'poison' : 'blade' };
    // 裁定 7：警长死亡落账即时标记警徽待处置（闸口①/③消费；gameOver 自然作废）
    if (s.sheriff && s.sheriff.seat === seat && !s.badge) s.badge = { pending: seat, next: null };
  }
  s.phase = 'day';
  s.night = null; // 天亮清空当夜瞬时信息（含 guardTarget；s.guard.last 持久保留）
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  // §4.2.1 天亮一次性公布全部死者（不区分先后、暗牌）；平安夜 = 刀口被救且无毒
  const events = [{ type: 'day_announce', day: s.day, dead: deadSeats, peaceful: deadSeats.length === 0 }];
  // §4.2.2 可开枪的夜死猎人 = 死于刀口且未死于毒；其翻牌开枪先于遗言。
  // §1.2（ADR-0013）狼王夜死不开枪——此处刻意保持 role === 'hunter' 精确匹配，不扩 isWolf
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
  return enterDayFlow(s, events);
}

/** 白天主链入口（裁定 7 闸口①）：警徽待处置（夜死 / 走完遗言链的被枪杀警长）→ 先进 badge；
 *  否则 day 1 未竞选 → 竞选；再进发言。 */
function enterDayFlow(s, events) {
  if (s.badge && s.badge.next === null) {
    s.badge.next = 'day';
    s.subPhase = 'badge';
    return ok(s, events);
  }
  return enterElectionOrSpeak(s, events);
}

/** §2.2 时序（ADR-0014）：day 1 竞选仅一次（enterLastwords 之后、enterSpeak 之前）；day≥2 直接发言。 */
function enterElectionOrSpeak(s, events) {
  if (s.day === 1 && s.sheriff && !s.sheriff.electDone) return enterElection(s, events);
  return enterSpeak(s, events);
}

/** §2.3 竞选入口：报名表态（join）起步，全员表态完按 0 / 1 / 多候选分流。 */
function enterElection(s, events) {
  s.sheriff.election = {
    stage: 'join', // join → campaign → withdraw → vote →（平票）pk_speak → pk_vote
    run: {}, // 报名表态 { 座位: true|false }
    candidates: [], // 报名且未退水的存活座位（座位序）
    quit: {}, // 退水表态 { 座位: true|false }（仅 withdraw 阶段候选人）
    votes: null, // { cast: { 座位: 目标|null } }（投票人 = 存活非候选人非翻牌白痴）
    queue: [], // campaign / pk_speak 发言队列
    pkCandidates: [], // 平票候选
  };
  s.subPhase = 'elect_join';
  return ok(s, events);
}

/** §4.2.4 发言：从存活最小座位号起，按座位顺序每人 1 条。 */
function enterSpeak(s, events) {
  s.subPhase = 'speak';
  s.queue = aliveSeats(s);
  return ok(s, events);
}

/* ---------- 白天（§4.2 / §2 警长竞选与警徽流，ADR-0014） ---------- */

function hHunterShoot(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || (s.subPhase !== 'night_hunter' && s.subPhase !== 'hunter')) {
    return fail(state, '当前不是猎人开枪阶段');
  }
  if (a.seat !== s.pendingHunter) return fail(state, '只有触发翻牌的猎人可以开枪');
  const hunter = s.players[s.pendingHunter - 1];
  // §1.2（ADR-0013）狼王翻牌带 role:'wolfking'；缺省省略按 hunter 渲染（向后兼容旧日志与旧板事件形状）
  const evRole = hunter.role === 'wolfking' ? { role: 'wolfking' } : {};
  const events = [{ type: 'hunter_flip', day: s.day, seat: hunter.seat, ...evRole }]; // 翻牌 = 唯一亮身份时机（§5.5）
  if (a.target === null || a.target === undefined) {
    events.push({ type: 'hunter_skip', day: s.day, seat: hunter.seat }); // 可放弃开枪（§5.6）
    return afterHunter(s, events);
  }
  const t = isAlive(s, a.target);
  if (!t) return fail(state, '枪目标必须是存活玩家');
  t.alive = false;
  t.death = { day: s.day, cause: 'shot' }; // 被枪杀者无遗言、不翻牌（§4.2.2 / §5.4）
  // 裁定 7：枪杀警长 → 死亡落账即时标记警徽待处置（night_hunter 走闸口①、放逐枪走闸口③）
  if (s.sheriff && s.sheriff.seat === t.seat && !s.badge) s.badge = { pending: t.seat, next: null };
  events.push({ type: 'hunter_shoot', day: s.day, seat: hunter.seat, target: t.seat, ...evRole }); // 枪杀 = 追加公布
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
      return enterDayFlow(s, events); // 遗言链走完 → 警徽闸口① / day1 竞选 / 发言（B1-4 同一守卫）
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
  if (p.idiotRevealed) return fail(state, '翻牌白痴无投票权'); // §1.4（ADR-0013）：免死后失去投票权（发言权保留）
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
  const pending = votersOf(s).filter((seat) => s.votes.cast[seat] === undefined); // §1.4 翻牌白痴不在待投名单
  if (pending.length > 0) return ok(s, events);
  return tally(s, events);
}

function tally(s, events) {
  const round = s.votes.round;
  const counts = new Map();
  for (const [seat, t] of Object.entries(s.votes.cast)) {
    if (t === null) continue;
    // §2.4（ADR-0014）警长 1.5 票：0.5 为二进制精确值，累加无浮点误差；
    // 狼队定刀走 resolveWolfVote 独立计票，不加权
    const w = s.sheriff && Number(seat) === s.sheriff.seat ? 1.5 : 1;
    counts.set(t, (counts.get(t) || 0) + w);
  }
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
  // §1.4（ADR-0013）白痴特判：被放逐翻牌免死（首次翻牌；已翻牌再被放逐同口径免疫）——
  // 不入死、跳遗言与猎人枪，直接放逐检查点（白痴没死不影响胜负判定；tally 不排除他当候选）
  if (p.role === 'idiot') {
    events.push({ type: 'vote_result', day: s.day, round: s.votes.round, tally: tallyList, exiled: seat, idiot: true });
    p.idiotRevealed = true;
    s.votes = null;
    s.pkCandidates = null;
    s.pendingExile = null;
    return checkAndNextNight(s, events);
  }
  p.alive = false;
  p.death = { day: s.day, cause: 'exile' };
  events.push({ type: 'vote_result', day: s.day, round: s.votes.round, tally: tallyList, exiled: seat }); // 放逐结果，暗牌
  // 裁定 7：被放逐者是警长 → 死亡落账即时标记警徽待处置（闸口②在遗言后消费）
  if (s.sheriff && s.sheriff.seat === seat && !s.badge) s.badge = { pending: seat, next: null };
  s.votes = null;
  s.pkCandidates = null;
  s.pendingExile = seat;
  s.subPhase = 'exile_lastwords'; // §4.2.6 被放逐者遗言（任何天数都有，§5.4）
  s.queue = [seat];
  return ok(s, events);
}

/** §4.2.8 放逐收尾：遗言后 → 警徽处置（裁定 7 闸口②，先于翻牌）→ 猎人/狼王翻牌 → 放逐检查点。 */
function finishExile(s, events) {
  const p = s.players[s.pendingExile - 1];
  // 裁定 7 闸口②：被放逐者是警长 → 警徽处置插在遗言后、猎人/狼王翻牌前
  if (s.badge && s.badge.pending === p.seat && s.badge.next === null) {
    s.badge.next = 'exile';
    s.subPhase = 'badge';
    return ok(s, events);
  }
  return afterBadgeExile(s, events, p);
}

/** 警徽处置后（或非警长直通）的放逐收尾：§1.2（ADR-0013）猎人 / 狼王仅被放逐时翻牌开枪。 */
function afterBadgeExile(s, events, p) {
  s.pendingExile = null;
  if (p.role === 'hunter' || p.role === 'wolfking') {
    s.subPhase = 'hunter'; // §4.2.7 被放逐猎人翻牌开枪（先遗言后翻牌）；狼王复用同管线
    s.pendingHunter = p.seat;
    return ok(s, events);
  }
  return checkAndNextNight(s, events); // §4.2.8 放逐检查点
}

function checkAndNextNight(s, events) {
  const w = checkWinner(s);
  if (w) return gameOver(s, events, w); // 终局不处置警徽（§2.3：gameOver 清 badge 自然作废）
  // 裁定 7 闸口③：白天被枪杀 / 放逐链走完仍有警徽待处置 → 先处置再入夜
  if (s.badge && s.badge.next === null) {
    s.badge.next = 'night';
    s.subPhase = 'badge';
    return ok(s, events);
  }
  return nextNight(s, events);
}

function nextNight(s, events) {
  s.day += 1;
  s.phase = 'night';
  s.subPhase = 'wolf';
  // 裁定 1：night 字面量仅 hStart / nextNight 两处，guardTarget 随之构造
  s.night = { blade: null, saved: false, poison: null, wolfVotes: {}, guardTarget: null };
  s.queue = [];
  s.votes = null;
  s.pkCandidates = null;
  s.pendingHunter = null;
  s.pendingExile = null;
  if (s.sheriff) s.sheriff.election = null; // 夜里无竞选；seat 不清（终局复盘要看）
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
  s.badge = null; // §2.3（ADR-0014）终局不处置警徽，标记作废
  if (s.sheriff) s.sheriff.election = null; // 竞选瞬态清空；seat 保留供终局复盘
  events.push({ type: 'game_over', day: s.day, winner: w.winner, reason: w.reason });
  return ok(s, events);
}

/* ---------- 警长竞选与警徽流（§2 / ADR-0014；day 1 唯一一次竞选，恒开启不分板） ---------- */

/** §2.3 警长竞选投票人：存活非翻牌白痴且非候选人（候选人不投票；PK 轮投票人不变）。 */
function electionVotersOf(s) {
  const el = s.sheriff && s.sheriff.election;
  const cands = el ? el.candidates : [];
  return votersOf(s).filter((seat) => !cands.includes(seat));
}

/** §2.3 上警表态（elect_join）：存活座位按序表态；全员表态完按 0 / 1 / 多候选分流。 */
function hElectRun(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || s.subPhase !== 'elect_join') return fail(state, '当前不是上警表态阶段');
  const p = isAlive(s, a.seat);
  if (!p) return fail(state, '只有存活玩家可以表态上警');
  const el = s.sheriff.election;
  if (el.run[a.seat] !== undefined) return fail(state, '该座位已表态过');
  if (a.run !== true && a.run !== false) return fail(state, 'run 必须为布尔值');
  el.run[a.seat] = a.run;
  const events = [{ type: 'elect_run', day: s.day, seat: p.seat, run: a.run }];
  if (aliveSeats(s).some((seat) => el.run[seat] === undefined)) return ok(s, events); // 还有座位未表态
  el.candidates = aliveSeats(s).filter((seat) => el.run[seat] === true); // 候选人按座位序
  if (el.candidates.length === 0) {
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'none' }); // 0 人上警 → 本局无警长
  }
  if (el.candidates.length === 1) {
    s.sheriff.seat = el.candidates[0]; // 唯一候选人直接当选，无需竞选发言与投票
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'elected', seat: el.candidates[0] });
  }
  el.stage = 'campaign';
  el.queue = el.candidates.slice();
  s.subPhase = 'elect_campaign';
  return ok(s, events);
}

/** §2.3 竞选发言（elect_campaign / elect_pk_speak）：队列头发言；队列空分别进退水窗口 / PK 重投。 */
function hElectSpeak(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || (s.subPhase !== 'elect_campaign' && s.subPhase !== 'elect_pk_speak')) {
    return fail(state, '当前不是竞选发言阶段');
  }
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (!text) return fail(state, '发言不能为空');
  if (text.length > SPEECH_MAX) return fail(state, `发言不得超过 ${SPEECH_MAX} 字`);
  const el = s.sheriff.election;
  const seat = el.queue.length > 0 ? el.queue[0] : undefined;
  if (seat === undefined || a.seat !== seat) return fail(state, '还没轮到该座位发言'); // 严格队列顺序，不可跳过
  el.queue.shift();
  const events = [{ type: 'elect_speech', day: s.day, seat, text }];
  if (el.queue.length > 0) return ok(s, events);
  if (el.stage === 'campaign') {
    el.stage = 'withdraw';
    s.subPhase = 'elect_withdraw';
    return ok(s, events);
  }
  el.stage = 'pk_vote'; // PK 发言完毕 → 重投（投票人不变）
  el.votes = { cast: {} };
  s.subPhase = 'elect_pk_vote';
  return ok(s, events);
}

/** §2.3 退水表态（elect_withdraw）：候选人按序表态；表态完按 0 / 1 / 多候选与投票人有无分流。 */
function hElectWithdraw(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || s.subPhase !== 'elect_withdraw') return fail(state, '当前不是退水表态阶段');
  const el = s.sheriff.election;
  const p = isAlive(s, a.seat);
  if (!p || !el.candidates.includes(p.seat)) return fail(state, '只有候选人可以表态退水'); // 非候选人不行动
  if (el.quit[p.seat] !== undefined) return fail(state, '该座位已表态过');
  if (a.quit !== true && a.quit !== false) return fail(state, 'quit 必须为布尔值');
  el.quit[p.seat] = a.quit;
  const events = [{ type: 'elect_withdraw', day: s.day, seat: p.seat, quit: a.quit }];
  if (el.candidates.some((seat) => el.quit[seat] === undefined)) return ok(s, events);
  el.candidates = el.candidates.filter((seat) => el.quit[seat] !== true); // 未退水者留台
  if (el.candidates.length === 0) {
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'none' }); // 全退水 → 本局无警长
  }
  if (el.candidates.length === 1) {
    s.sheriff.seat = el.candidates[0]; // 只剩 1 人 → 直接当选
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'elected', seat: el.candidates[0] });
  }
  if (electionVotersOf(s).length === 0) {
    // §2.1 全员上警（存活者全是候选人）→ 无投票人 → 本局无警长（简化口径：不做互投规则）
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'no-voters' });
  }
  el.stage = 'vote';
  el.votes = { cast: {} };
  s.subPhase = 'elect_vote';
  return ok(s, events);
}

/** §2.3 警长竞选投票（elect_vote / elect_pk_vote）：投票人 = 存活非候选人非翻牌白痴；可弃票。 */
function hElectVote(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || (s.subPhase !== 'elect_vote' && s.subPhase !== 'elect_pk_vote')) {
    return fail(state, '当前不是警长投票阶段');
  }
  const el = s.sheriff.election;
  const voters = electionVotersOf(s);
  if (!voters.includes(a.seat)) return fail(state, '只有存活非候选人可以投警长票'); // 投票人不含候选人，天然无自投
  if (el.votes.cast[a.seat] !== undefined) return fail(state, '该座位已投过票');
  const target = a.target === undefined ? null : a.target;
  if (target !== null) {
    const pool = s.subPhase === 'elect_pk_vote' ? el.pkCandidates : el.candidates;
    if (!pool.includes(target)) return fail(state, '警长投票只能投台上的候选人');
  }
  el.votes.cast[a.seat] = target;
  const events = [{ type: 'elect_vote', day: s.day, seat: a.seat, target }];
  if (voters.some((seat) => el.votes.cast[seat] === undefined)) return ok(s, events);
  return tallyElection(s, events);
}

/** §2.3 竞选计票：一人一票（警长未定，无 1.5 权重）；主轮平票 → PK；PK 再平 / 全弃 → 本局无警长。 */
function tallyElection(s, events) {
  const el = s.sheriff.election;
  const counts = new Map();
  for (const t of Object.values(el.votes.cast)) if (t !== null) counts.set(t, (counts.get(t) || 0) + 1);
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  const top = [...counts.keys()].filter((seat) => counts.get(seat) === max).sort((x, y) => x - y);
  if (top.length === 1) {
    s.sheriff.seat = top[0];
    return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'elected', seat: top[0] });
  }
  if (el.stage === 'vote' && top.length > 1) {
    // 裁定 11：平票 → tie-pk 事件带 PK 台名单；其余落选候选人出局但不死（本局不再参选）
    events.push({ type: 'sheriff_result', day: s.day, kind: 'tie-pk', pk: top });
    el.stage = 'pk_speak';
    el.pkCandidates = top;
    el.queue = top.slice();
    s.subPhase = 'elect_pk_speak';
    return ok(s, events);
  }
  // 主轮全弃（无顶票）或 PK 再平 → 本局无警长
  return finishElection(s, events, { type: 'sheriff_result', day: s.day, kind: 'none' });
}

/** 竞选出结论（当选 / 无警长 / 无投票人）：清竞选态、标记已竞选、进白天发言。 */
function finishElection(s, events, result) {
  events.push(result);
  s.sheriff.election = null;
  s.sheriff.electDone = true; // §2.2 仅 day 1 竞选一次
  return enterSpeak(s, events);
}

/** §2.3 警徽处置（badge）：死亡警长本人移交警徽给存活座位或撕毁；按裁定 7 的 next 恢复原链。 */
function hBadgeMove(state, a) {
  const s = clone(state);
  if (s.phase !== 'day' || s.subPhase !== 'badge') return fail(state, '当前不是警徽处置阶段');
  if (!s.badge || a.seat !== s.badge.pending) return fail(state, '只有待处置警徽的警长可以移交警徽');
  const target = a.target === undefined ? null : a.target;
  if (target !== null && !isAlive(s, target)) return fail(state, '警徽接收者必须是存活玩家');
  const events = [{ type: 'badge_move', day: s.day, from: a.seat, to: target }];
  s.sheriff.seat = target; // 移交 → 新警长；null → 撕毁，本局无警长
  const next = s.badge.next;
  s.badge = null;
  if (next === 'exile') return afterBadgeExile(s, events, s.players[s.pendingExile - 1]); // 闸口②：badge 后重走猎人/狼王翻牌判定
  if (next === 'night') return checkAndNextNight(s, events); // 闸口③：badge 后入夜
  return enterElectionOrSpeak(s, events); // 闸口①：badge 后回白天主链（day 1 未竞选则先竞选）
}

/* ---------- 确定性回退（§8.4 / §5.11：DO 150s 超时与客户端 AI 失败共用同一份） ---------- */

const FALLBACK_LINES = [
  '我先听听大家的意见。',
  '这轮信息不多，我先保留判断。',
  '我先过，看看后面的发言再说。',
  '目前没有特别的线索，先不站边。',
];

/**
 * 遗言回退：按身份交代基础信息（§5.4 提示词同口径——死了不能白死，
 * 「先过/再观察」从死者嘴里说出来是穿帮）。只用本人私有信息（验人记录、
 * 药剂状态）与公开的存活名单，绝不泄他人底牌；狼装好人给一个随机怀疑。
 */
function lastwordsLine(s, seat) {
  const p = s.players[seat - 1];
  const pool = aliveSeats(s).filter((x) => x !== seat);
  let mark = '';
  if (pool.length) {
    const [t, rng] = pick(pool, s.rng); // 直觉怀疑方向：随机存活玩家（确定性走 state.rng）
    s.rng = rng;
    mark = `${t} 号有点不对劲，先盯一下`;
  }
  switch (p.role) {
    case 'seer': {
      const cs = (s.seerChecks || []).map((c) => `第${c.night}夜验${c.target}号是${c.isWolf ? '狼人' : '好人'}`);
      return cs.length
        ? `我是预言家，死前交底：${cs.join('，')}。这条信息别浪费，大家接着盘。`
        : `我是预言家，还没来得及验人就被刀了。狼这么怕神职视角，说明刀口暴露了他们的心思。${mark}。`;
    }
    case 'witch': {
      const w = s.witch || {};
      const antidote = (w.antidote || 0) > 0 ? '解药还在' : '解药用掉了';
      const poison = (w.poison || 0) > 0 ? '毒药还在' : '毒药用掉了';
      return `我是女巫。${antidote}，${poison}，这条信息比我的命值钱。${mark}。`;
    }
    case 'hunter':
      return `我是猎人，走得突然。${mark}，这是我最后的直觉，信不信由你们。`;
    case 'werewolf':
    case 'wolfking': // §1.2（ADR-0013）狼王处处视作狼：遗言同款伪装口径
      return `我是平民，死得冤。${mark}，到死我都这么觉得，你们替我验一验。`;
    default:
      return `我是平民。${mark}，没有实锤，纯直觉，大家帮我接着往下盘。`;
  }
}

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
      action = { type: 'speak', seat, text: lastwordsLine(s, seat) }; // 遗言按身份爆信息，死者不能白死
      break;
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
    case 'night:guard': {
      // §1.3（ADR-0013）守卫回退：随机存活且不与上一晚同人（池空任选存活，含守自己）
      let pool = aliveSeats(s).filter((x) => x !== (s.guard && s.guard.last));
      if (pool.length === 0) pool = aliveSeats(s);
      const [t, rng] = pick(pool, s.rng);
      s.rng = rng;
      action = { type: 'guard_protect', seat, target: t };
      break;
    }
    case 'day:night_hunter':
    case 'day:hunter':
      return advance(s, { type: 'hunter_shoot', seat, target: null }); // 猎人回退 = 不开枪
    case 'day:elect_join':
      action = { type: 'elect_run', seat, run: false }; // §2.4（ADR-0014）竞选回退 = 不上警
      break;
    case 'day:elect_withdraw':
      action = { type: 'elect_withdraw', seat, quit: false }; // §2.4 退水回退 = 留在台上
      break;
    case 'day:elect_campaign':
    case 'day:elect_pk_speak':
      action = { type: 'elect_speak', seat, text: FALLBACK_LINES[seat % FALLBACK_LINES.length] }; // 固定兜底句，按座位轮换
      break;
    case 'day:elect_vote':
    case 'day:elect_pk_vote': {
      // §2.4 竞选投票回退 = 随机候选人（无可投候选则弃票）
      const el = s.sheriff.election;
      const pool = (s.subPhase === 'elect_pk_vote' ? el.pkCandidates : el.candidates).filter((x) => x !== seat);
      if (pool.length === 0) return advance(s, { type: 'elect_vote', seat, target: null });
      const [t, rng] = pick(pool, s.rng);
      s.rng = rng;
      action = { type: 'elect_vote', seat, target: t };
      break;
    }
    case 'day:badge':
      return advance(s, { type: 'badge_move', seat, target: null }); // §2.4 警徽回退 = 撕毁
    case 'day:vote':
    case 'day:pk_vote': {
      // §1.4 投票兜底池用 votersOf（排除翻牌白痴）；PK 轮投 PK 台上的人
      let pool = s.subPhase === 'pk_vote' ? s.pkCandidates : votersOf(s);
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
