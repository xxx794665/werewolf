/* ============================================================
 * js/app.js —— 应用入口与切屏状态机
 * ------------------------------------------------------------
 * 屏幕流转（显隐 index.html 的 .screen，URL 不变）：
 *   menu → solo / online / settings → lobby → game → revealed
 * 双模式（features.md §6 / §7）：
 *   - 单机 = 浏览器本地跑 shared/game.js 内核（1 真人 + 8 AI），
 *     AI 请求经 js/ai.js → /api/ai-proxy（BYO Key 只存 localStorage）；
 *     不设行动超时（§5.11）。不走 Worker 建房——内核 start 要求真人 ≥3（§7.4），
 *     1 真人局只能在本地开（start 加 solo 开关，ADR-0003）。
 *   - 联机 = net.js 轮询 Worker 房间；AI 座位 / 托管座位由房主浏览器驱动
 *     （act("drive_ai")，服务端组装提示词，docs/ai-prompts.md §5.3.2 路径——
 *     夜里快照对非行动者冻结（§4.1.6），客户端拿不到「夜里轮到谁」，
 *     纯客户端 ai_view 路径在夜里无法驱动，ADR-0003 记录该口径选择）。
 * 玩家身份：localStorage 的 uid + 昵称（断线重连依据，§2）。
 * 不可逆操作全部两步确认（§1）：确认条归 ui.js，本文件只递回调。
 * ============================================================ */

import * as game from "../shared/game.js";
import * as net from "./net.js";
import * as ai from "./ai.js";
import * as ui from "./ui.js";
import * as archive from "./archive.js"; // §3（ADR-0015）本地存档 / 战绩：终局落档 + 复盘屏数据源

/* ---------- 全局状态 ---------- */

let mode = null; // 'solo' | 'online' | null
let solo = null; // { state, log, driving }
let snap = null; // 最近一次联机快照
let screen = "screen-menu";

const $ = (id) => document.getElementById(id);

function go(id, subtitle) {
  screen = id;
  ui.hideConfirm();
  ui.show(id);
  ui.setSubtitle(subtitle || "");
}

/* ============================================================
 * 单机模式（本地引擎：state + 公开事件账本，全部经 shared/game.js 内核）
 * ============================================================ */

const SOLO_KEY = "ww_solo";

function saveSolo() {
  try {
    localStorage.setItem(SOLO_KEY, JSON.stringify({ state: solo.state, log: solo.log }));
  } catch (e) {
    /* 存不下就丢（隐私模式等）：当局游戏仍可继续，只是刷新不恢复 */
  }
}
function loadSolo() {
  try {
    const s = JSON.parse(localStorage.getItem(SOLO_KEY) || "null");
    return s && s.state && Array.isArray(s.log) ? s : null;
  } catch (e) {
    return null;
  }
}
function clearSolo() {
  localStorage.removeItem(SOLO_KEY);
}

/** 本人私有视角（worker/src/room-logic.js privateOf 的客户端同款，按 §4.1.6 口径；
 *  §1.2–1.4 ADR-0013 同步：判狼走 isWolf（含狼王）、守卫 guardLast、翻牌白痴 idiotRevealed）。 */
function privateOf(g, seat) {
  const meP = g.players[seat - 1];
  const you = { seat, alive: !!meP.alive, role: meP.role };
  if (game.isWolf(meP.role)) {
    you.wolves = g.players.filter((p) => p && game.isWolf(p.role)).map((p) => p.seat);
    if (meP.alive) you.wolfChatLog = g.wolfChatLog || []; // §4.1.1 跨夜保留，白天可回看
    if (g.phase === "night" && meP.alive && g.night) {
      if (g.night.blade != null) you.blade = g.night.blade;
      you.wolfVotes = g.night.wolfVotes || {};
      you.captain = game.wolfCaptain(g);
    }
  }
  if (meP.role === "seer") {
    you.checks = (g.seerChecks || []).map((c) => ({ night: c.night, seat: c.target, result: c.isWolf ? "wolf" : "good" }));
  }
  if (meP.role === "witch" && g.witch) {
    you.antidote = g.witch.antidote > 0;
    you.poison = g.witch.poison > 0;
    const blade = game.witchSeesBlade(g); // 仅女巫子阶段且解药未用（§4.1.3）
    if (blade != null) you.blade = blade;
  }
  if (meP.role === "guard") {
    you.guardLast = g.guard && g.guard.last != null ? g.guard.last : null; // 裁定 10：连守限制依据（旧存档无 guard 字段 → null）
  }
  if (meP.idiotRevealed) you.idiotRevealed = true; // §1.4：翻牌白痴失去投票权（本人提示）
  return you;
}

/** 单机真人座位（§3 开局座位洗牌后不再恒为 1，按 isAI 反查）。 */
function soloHumanSeat() {
  const i = solo ? solo.state.players.findIndex((p) => p && !p.isAI) : -1;
  return i >= 0 ? i + 1 : 1;
}

/** 单机本地构造与联机快照同形的视图（ui.js 不区分两种来源）。 */
function soloSnap() {
  const g = solo.state;
  const night = g.phase === "night";
  const revealed = g.phase === "revealed";
  const mySeat = soloHumanSeat();
  const meP = g.players[mySeat - 1];
  const pending = g.phase === "night" || g.phase === "day" ? game.pendingSeat(g) : null;
  /* 死者观战亮牌时机：自己还有待提交行动（遗言 / 开枪）时只看自己身份，
     提交后可见全员身份（§7.8，2026-10-03 试玩反馈定的时机） */
  const spectator = g.phase !== "lobby" && !revealed && !meP.alive && pending !== mySeat;
  const s = {
    solo: true,
    code: null,
    mySeat,
    phase: g.phase,
    day: g.day,
    players: g.players.map((p) => {
      const e = { seat: p.seat, nick: p.nick, isAI: !!p.isAI, alive: !!p.alive };
      if (p.idiotRevealed) e.idiotRevealed = true; // §1.4（ADR-0013）白痴翻牌态是公开信息（vote_result 已宣告）
      if (revealed || spectator || p.seat === mySeat) {
        e.role = p.role;
        if (p.death) e.death = p.death;
      }
      return e;
    }),
    events: solo.log,
    you: privateOf(g, mySeat),
  };
  /* §1.6 / §2.5（ADR-0013/0014）公开层新字段（与 room-logic snapshotFor 同形；
     旧存档缺字段则不带——UI 侧全部判空容错） */
  if (g.board != null) s.board = g.board;
  if (g.sheriff) s.sheriff = { seat: g.sheriff.seat == null ? null : g.sheriff.seat }; // 警长全程公开（含夜里）
  if (!night) {
    const eln = g.sheriff && g.sheriff.election;
    if (eln) {
      s.election = {
        stage: eln.stage,
        candidates: (eln.candidates || []).slice(),
        ...(eln.stage === "join" ? { run: { ...eln.run } } : {}),
        ...(eln.stage === "withdraw" ? { quit: { ...eln.quit } } : {}),
        ...(eln.pkCandidates && eln.pkCandidates.length ? { pkCandidates: eln.pkCandidates.slice() } : {}),
      };
    }
    s.subPhase = g.subPhase; // §4.1.6：夜里不露子阶段
    if (pending != null) s.pending = pending;
    if (g.pkCandidates) s.pkCandidates = g.pkCandidates;
    /* 单机 AI 行动倒计时：数据源 = soloDrive 写入的行动总预算（含重试，§8.4）；
       只在白天透出（夜里倒计时重置节奏会泄漏预言家 / 女巫是否存活，§4.1.6） */
    if (g.phase === "day" && pending != null && g.players[pending - 1].isAI && solo.stepEndsAt) {
      s.deadline = { at: solo.stepEndsAt, seat: pending };
    }
  }
  if (revealed) {
    s.winner = g.winner;
    s.reason = g.reason;
  }
  if (pending === mySeat && ai.phaseOf(g)) s.action = { kind: ai.phaseOf(g) };
  else if (meP.alive && game.isWolf(meP.role) && g.phase === "night" && g.subPhase === "wolf") {
    s.action = { kind: "wolf" }; // §4.1.1 狼队密聊+投票全员开放（§1.2 狼王同口径，不按 pending 排队）
  }
  return s;
}

/* 板子选择（§1.1，ADR-0013）：单机屏 / 联机大厅房主各持一份选中态，默认 standard */
let soloBoard = game.DEFAULT_BOARD;
let lobbyBoard = game.DEFAULT_BOARD;

function renderSoloBoards() {
  ui.renderBoardPicker($("solo-boards"), soloBoard, (id) => {
    soloBoard = id;
    renderSoloBoards();
  });
}
function renderLobbyBoards() {
  ui.renderBoardPicker($("lobby-boards"), lobbyBoard, (id) => {
    lobbyBoard = id;
    renderLobbyBoards();
  });
}

async function startSolo(nick) {
  const uid = net.me().uid;
  let r = game.advance(game.createInitialState(), { type: "join", nick, uid });
  if (r.error) return ui.toast(r.error);
  r = game.advance(r.state, { type: "ready", seat: 1, ready: true });
  /* AI 名册（人格 × 网名，与身份无关，ADR-0009）：Worker 抽取，3s 超时本地兜底 */
  const roster = await ai.fetchRoster(8);
  r = game.advance(r.state, {
    type: "start",
    seed: crypto.getRandomValues(new Uint32Array(1))[0] | 0,
    solo: true,
    roster,
    board: soloBoard, // §1.1：板子选择屏的选中值透传内核
  });
  if (r.error) return ui.toast(r.error);
  mode = "solo";
  solo = { state: r.state, log: [], driving: false };
  saveSolo();
  ui.resetTags("solo"); // 玩家标签是本局笔记：新局清零（刷新恢复同局不受影响）
  enterGame();
  soloDrive();
}

function soloSubmit(action) {
  if (!solo) return;
  const r = game.advance(solo.state, action);
  if (r.error) {
    ui.toast(r.error);
    return;
  }
  solo.state = r.state;
  solo.log.push(...ai.toHistory(r.events));
  saveSolo();
  renderSolo();
  soloDrive();
}

const soloActions = {
  speak: (text) => soloSubmit({ type: "speak", seat: soloHumanSeat(), text }),
  vote: (target) => soloSubmit({ type: "vote", seat: soloHumanSeat(), target }),
  wolfChat: (text) => soloSubmit({ type: "wolf_chat", seat: soloHumanSeat(), text }),
  wolfTarget: (target) => soloSubmit({ type: "wolf_target", seat: soloHumanSeat(), target }),
  seerCheck: (target) => soloSubmit({ type: "seer_check", seat: soloHumanSeat(), target }),
  witchSave: () => soloSubmit({ type: "witch_move", seat: soloHumanSeat(), move: "save" }),
  witchPoison: (target) => soloSubmit({ type: "witch_move", seat: soloHumanSeat(), move: "poison", target }),
  witchSkip: () => soloSubmit({ type: "witch_move", seat: soloHumanSeat(), move: "skip" }),
  hunterShoot: (target) => soloSubmit({ type: "hunter_shoot", seat: soloHumanSeat(), target }),
  /* §1.3 守卫 / §2.6 警长竞选与警徽流（ADR-0013/0014）：内核 type 直交 */
  guardProtect: (target) => soloSubmit({ type: "guard_protect", seat: soloHumanSeat(), target }),
  electRun: (run) => soloSubmit({ type: "elect_run", seat: soloHumanSeat(), run }),
  electSpeak: (text) => soloSubmit({ type: "elect_speak", seat: soloHumanSeat(), text }),
  electWithdraw: (quit) => soloSubmit({ type: "elect_withdraw", seat: soloHumanSeat(), quit }),
  electVote: (target) => soloSubmit({ type: "elect_vote", seat: soloHumanSeat(), target }),
  badgeMove: (target) => soloSubmit({ type: "badge_move", seat: soloHumanSeat(), target }),
};

function renderSolo() {
  if (!solo) return;
  if (screen === "screen-game") ui.renderGame(soloSnap(), soloActions);
}

/** 单机 AI 驱动：轮到 AI 座位就依次代打，直到轮到玩家本人或终局。 */
async function soloDrive() {
  if (!solo || solo.driving) return;
  solo.driving = true;
  try {
    let guard = 0;
    while (guard++ < 40) {
      const g = solo.state;
      if (g.phase !== "night" && g.phase !== "day") break;
      const pending = game.pendingSeat(g);
      if (pending == null) break;
      const p = g.players[pending - 1];
      if (!p || !p.isAI) break; // 轮到玩家本人，等操作
      solo.stepEndsAt = Date.now() + ai.AI_STEP_BUDGET_MS; // 本个 AI 行动的总预算（重试含内），倒计时数据源
      renderSolo();
      const d = await ai.decideFor(g, solo.log, pending); // buildMessages → /api/ai-proxy → 解析 + 干跑校验（含重试）
      if (d.chat) {
        // §4.1.1 狼队密聊：先入频道再投票（chat 不推进 pendingSeat，投票照常有效）
        const c = game.advance(solo.state, { type: "wolf_chat", seat: pending, text: d.chat });
        if (!c.error) {
          solo.state = c.state;
          saveSolo();
        }
      }
      let r = d.action ? game.advance(solo.state, d.action) : { error: "ai-failed" };
      if (r.error) r = game.applyFallback(solo.state, pending); // §8.4 确定性回退，不打断游戏
      if (r.error) break; // 回退与内核同源，理论上不可达；防死循环兜底
      solo.state = r.state;
      solo.log.push(...ai.toHistory(r.events));
      saveSolo();
      renderSolo();
    }
  } finally {
    if (solo) solo.driving = false;
  }
  if (solo && solo.state.phase === "revealed") {
    archiveSoloIfRevealed(); // §3.2（ADR-0015）：终局转移点落档（id 幂等）
    enterRevealed(soloSnap());
  }
}

/* ---------- 本地存档落档（§3.2，ADR-0015）：终局触发，id 幂等，失败静默 ---------- */

const archivedIds = new Set(); // 本会话已入档 id（防轮询重复写盘；跨会话由 mergeArchive 按 id 去重兜底）

function archiveSoloIfRevealed() {
  if (!solo || solo.state.phase !== "revealed") return;
  const rec = archive.buildArchiveRecord(solo.state, solo.log, { mode: "solo" }); // id 缺省 solo:${seed}
  if (!rec || archivedIds.has(rec.id)) return;
  archivedIds.add(rec.id);
  archive.saveArchive(rec);
}

function archiveOnlineIfRevealed(s) {
  if (!s || s.phase !== "revealed") return;
  /* 快照即终局全量视图：players 已全员亮 role/death、events = 房间公开日志、board/winner/reason 齐备 */
  const rec = archive.buildArchiveRecord(
    { board: s.board, winner: s.winner, reason: s.reason, day: s.day, players: s.players },
    s.events,
    { mode: "online", id: "online:" + s.code },
  );
  if (!rec || archivedIds.has(rec.id)) return;
  archivedIds.add(rec.id);
  archive.saveArchive(rec);
}

/* ============================================================
 * 联机模式（net.js 轮询 + 房主驱动 AI）
 * ============================================================ */

function enterOnlineRoom(code) {
  mode = "online";
  net.watch(code, onSnapshot);
}

function onSnapshot(err, s) {
  if (err) {
    if (err.gone) {
      ui.toast("房间不存在或你已不在该房间");
      leaveToMenu();
    }
    return; // 其余错误（网络重试中）不打断
  }
  snap = s;
  if (s.abandoned) ui.toast("房主失联，房间已作废，请重建新房"); // §7.7
  if (s.phase === "lobby") {
    if (screen !== "screen-lobby") go("screen-lobby", `房间 ${s.code}`);
    renderLobby(s);
  } else if (s.phase === "revealed") {
    archiveOnlineIfRevealed(s); // §3.2（ADR-0015）：收到 revealed 的那一次落档（id 幂等）
    enterRevealed(s);
  } else {
    if (screen !== "screen-game") go("screen-game", `房间 ${s.code}`);
    ui.renderGame(s, onlineActions);
    maybeDriveAI(s);
  }
}

function renderLobby(s) {
  const meUid = net.me().uid;
  const humans = s.players.filter((p) => p && !p.isAI);
  const isOwner = s.owner === meUid;
  const allReady = humans.every((p) => p.ready);
  ui.renderLobby(s, { isOwner, canStart: isOwner && humans.length >= 3 && allReady });
  /* §1.1（ADR-0013）板子选择：仅房主可见，随「开始游戏」提交；非房主不显示 */
  $("lobby-board-wrap").hidden = !isOwner;
}

async function submitAct(action, body) {
  const r = await net.act(action, body);
  if (r && r.error) ui.toast(String(r.error));
  return r;
}

const onlineActions = {
  speak: (text) => submitAct("speak", { text }),
  vote: (target) => submitAct("vote", { target }),
  wolfChat: (text) => submitAct("wolf-chat", { text }),
  wolfTarget: (target) => submitAct("wolf-target", { target }),
  seerCheck: (target) => submitAct("seer-check", { target }),
  witchSave: () => submitAct("witch-move", { move: "save" }),
  witchPoison: (target) => submitAct("witch-move", { move: "poison", target }),
  witchSkip: () => submitAct("witch-move", { move: "skip" }),
  hunterShoot: (target) => submitAct("hunter-shoot", { target }),
  /* §1.3 守卫 / §2.6 警长竞选与警徽流（ADR-0013/0014）：HTTP 路由名 kebab-case，body 不带 seat */
  guardProtect: (target) => submitAct("guard-protect", { target }),
  electRun: (run) => submitAct("elect-run", { run }),
  electSpeak: (text) => submitAct("elect-speak", { text }),
  electWithdraw: (quit) => submitAct("elect-withdraw", { quit }),
  electVote: (target) => submitAct("elect-vote", { target }),
  badgeMove: (target) => submitAct("badge-move", { target }),
};

/* ---- 房主驱动 AI（§7.6：快照 owner == me 才驱动） ----
 * 夜里房主自己的快照也是冻结的（§4.1.6），驱动不能依赖快照变化，
 * 故除快照触发外另有一个 4s 兜底节拍；drive_ai 在无 AI 待行动时回错即停。
 * 未配置自有接口也照常驱动：走内置体验通道（key 由 Worker Secret 注入），
 * 体验通道不可用时 DO 的 150s 行动超时回退兜底（§5.11）。 */

let aiTimer = null;
let aiDriving = false;

function maybeDriveAI(s) {
  if (mode !== "online" || !s) return;
  if (s.owner !== net.me().uid) return;
  if (s.phase !== "night" && s.phase !== "day") return;
  if (!aiTimer) {
    aiTimer = setTimeout(() => {
      aiTimer = null;
      driveLoop();
    }, 400);
  }
}

async function driveLoop() {
  if (aiDriving) return;
  aiDriving = true;
  try {
    const cfg = ai.effectiveConfig(); // 自带配置优先，空配置走体验通道
    for (let i = 0; i < 12; i++) {
      const r = await net.driveAI(cfg); // 一次调用 = 一个 AI 座位行动（服务端组装 + 回退兜底）
      if (!r || !r.ok) break; // NO_PENDING / STALE / BUSY / FORBIDDEN → 等下个触发
      await new Promise((res) => setTimeout(res, 250));
    }
  } catch (e) {
    /* 网络异常：下个节拍再来 */
  } finally {
    aiDriving = false;
  }
}

/* ============================================================
 * 屏幕公共逻辑
 * ============================================================ */

function enterGame() {
  go("screen-game", mode === "online" && snap ? `房间 ${snap.code}` : "单机对局");
  if (mode === "solo") renderSolo();
  else if (snap) ui.renderGame(snap, onlineActions);
}

function enterRevealed(s) {
  go("screen-revealed", "终局复盘");
  ui.renderRevealed(s);
}

function leaveToMenu() {
  net.unwatch();
  if (mode === "solo" && solo && solo.state.phase === "revealed") clearSolo();
  if (mode === "online" && snap && snap.phase === "revealed") net.clearSession();
  mode = null;
  solo = null;
  snap = null;
  go("screen-menu");
}

function takeNick(inputId) {
  const nick = $(inputId).value.trim();
  if (!nick) {
    ui.toast("先填昵称");
    return null;
  }
  net.setNick(nick);
  return nick;
}

/* ---------- 事件接线 ---------- */

function bind() {
  for (const b of document.querySelectorAll("[data-goto]")) {
    b.addEventListener("click", () => {
      const target = b.getAttribute("data-goto");
      if (target === "screen-menu") leaveToMenu();
      else if (target === "screen-online") enterOnlineScreen();
      else if (target === "screen-settings") fillSettings();
      else if (target === "screen-archive") ui.renderArchive(archive.loadArchives(), net.me().nick); // §3.3 战绩与复盘
      go(target, { "screen-solo": "单机开局", "screen-online": "联机房间", "screen-settings": "AI 设置", "screen-archive": "战绩与复盘" }[target] || "");
    });
  }

  /* 板子选择卡（§1.1）：单机屏与联机大厅（房主）各一份，选中态留本屏 */
  renderSoloBoards();
  renderLobbyBoards();

  /* 单机开局（开始游戏 = 不可逆，两步确认，§1） */
  $("solo-start").addEventListener("click", () => {
    const nick = takeNick("solo-nick");
    if (!nick) return;
    if (!ai.hasConfig()) ui.toast("未配置自有 AI 接口：AI 走内置体验通道（可在 AI 设置里换成自己的）");
    const boardName = (game.BOARDS[soloBoard] || game.BOARDS[game.DEFAULT_BOARD]).name;
    ui.showConfirm(`以「${nick}」开始单机对局（${boardName}，你 + 8 个 AI）`, () => startSolo(nick));
  });

  /* 建房 / 进房 / 回房 */
  $("host-create").addEventListener("click", async () => {
    const nick = takeNick("host-nick");
    if (!nick) return;
    const r = await net.createRoom(nick);
    if (r && r.error) return ui.toast(String(r.error));
    ui.toast(`房间已创建：${r.code}`);
    enterOnlineRoom(r.code);
  });
  $("join-enter").addEventListener("click", async () => {
    const nick = takeNick("join-nick");
    if (!nick) return;
    const r = await net.joinRoom($("join-code").value, nick);
    if (r && r.error) return ui.toast(String(r.error));
    enterOnlineRoom(r.code);
  });
  $("join-resume").addEventListener("click", () => {
    const sess = net.loadSession();
    if (sess) enterOnlineRoom(sess.code);
  });

  /* 大厅：准备 / 开始 */
  $("btn-ready").addEventListener("click", async () => {
    if (!snap) return;
    const meP = snap.players[snap.mySeat - 1];
    await submitAct("ready", { ready: !(meP && meP.ready) });
  });
  $("btn-start").addEventListener("click", () => {
    if (!snap) return;
    const humans = snap.players.filter((p) => p && !p.isAI);
    if (humans.length < 3) return ui.toast("至少 3 名真人才能开桌（空位会由 AI 补足）"); // §7.4
    if (!humans.every((p) => p.ready)) return ui.toast("仍有真人未准备");
    const empty = 9 - snap.players.filter(Boolean).length;
    const boardName = (game.BOARDS[lobbyBoard] || game.BOARDS[game.DEFAULT_BOARD]).name;
    const text =
      (empty > 0
        ? `将补 ${empty} 个 AI 补足 9 人开局（以提交瞬间房间实况为准）` // §7.4：N 只是预估
        : "9 人满员，确认开局") + `；板子：${boardName}`;
    ui.showConfirm(text, async () => {
      const r = await submitAct("start", { board: lobbyBoard }); // §1.1：房主选板随 start 提交
      if (r && r.ok && typeof r.aiFilled === "number" && r.aiFilled > 0) ui.toast(`已开局，AI 补位 ${r.aiFilled} 个`);
    });
  });

  /* 房号点击复制 */
  $("room-code-line").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("room-code").textContent);
      ui.toast("房号已复制");
    } catch (e) {
      /* 剪贴板不可用时静默（房号本就显示着） */
    }
  });

  /* 离开对局（防困死：单机进度在 localStorage，不清就永远被自动恢复） */
  $("btn-leave-game").addEventListener("click", () => {
    if (mode === "solo") {
      ui.showConfirm("离开并放弃这局单机对局（进度不保留）", () => {
        clearSolo();
        leaveToMenu();
      });
    } else {
      ui.showConfirm("离开房间（房间继续存在，可从「联机房间」页回到房间）", () => leaveToMenu());
    }
  });

  $("cfg-save").addEventListener("click", () => {
    const baseUrl = $("cfg-baseurl").value.trim();
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      ui.toast("接口地址必须以 http:// 或 https:// 开头");
      return;
    }
    ai.saveConfig({ baseUrl, key: $("cfg-key").value, model: $("cfg-model").value, maxTokens: $("cfg-maxtokens").value });
    ui.toast("已保存（只存本机浏览器）");
  });

  /* 测试连接：用输入框里的当前值（未保存也能测），走与游戏相同的 /api/ai-proxy 链路 */
  $("cfg-test").addEventListener("click", async () => {
    const btn = $("cfg-test");
    const out = $("cfg-test-result");
    btn.disabled = true;
    out.hidden = false;
    out.textContent = "测试中…（思考型模型最长 60 秒）";
    const r = await ai.testConnection({
      baseUrl: $("cfg-baseurl").value.trim(),
      key: $("cfg-key").value,
      model: $("cfg-model").value,
      maxTokens: $("cfg-maxtokens").value,
    });
    btn.disabled = false;
    out.textContent = r.ok
      ? `连接正常 · ${r.ms}ms · 上游回复：${r.reply}`
      : `连接失败：${r.error}`;
  });
}

function enterOnlineScreen() {
  const sess = net.loadSession();
  const btn = $("join-resume");
  if (sess && mode !== "online") {
    btn.hidden = false;
    btn.textContent = `回到房间 ${sess.code}`;
  } else {
    btn.hidden = true;
  }
}

function fillSettings() {
  const c = ai.loadConfig();
  $("cfg-baseurl").value = c.baseUrl;
  $("cfg-key").value = c.key;
  $("cfg-model").value = c.model;
  $("cfg-maxtokens").value = c.maxTokens;
}

/* ---------- 启动 ---------- */

function boot() {
  ui.initTopbar();
  ui.initConfirmBar();
  bind();

  const nick = net.me().nick;
  if (nick) {
    $("solo-nick").value = nick;
    $("host-nick").value = nick;
    $("join-nick").value = nick;
  }

  /* 房主驱动 AI 的兜底节拍：夜里快照冻结（§4.1.6），不能只靠快照触发 */
  setInterval(() => maybeDriveAI(snap), 4000);

  /* 断线重连 / 刷新恢复（§2：localStorage 固定身份）；
     旧版存档（无 board/guard/sheriff 字段）由 privateOf / soloSnap 判空容错，内核自带兜底 */
  const s = loadSolo();
  if (s) {
    mode = "solo";
    solo = { state: s.state, log: s.log, driving: false };
    if (solo.state.phase === "revealed") {
      archiveSoloIfRevealed(); // §3.2：恢复到的旧终局也补落档（id 幂等）
      enterRevealed(soloSnap());
    } else {
      enterGame();
      soloDrive(); // 恢复后先把欠下的 AI 行动补上
    }
    return;
  }
  const sess = net.loadSession();
  if (sess) {
    ui.toast("正在回到房间…");
    enterOnlineRoom(sess.code);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
