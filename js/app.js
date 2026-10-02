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

/** 本人私有视角（worker/src/room-logic.js privateOf 的客户端同款，按 §4.1.6 口径）。 */
function privateOf(g, seat) {
  const meP = g.players[seat - 1];
  const you = { seat, alive: !!meP.alive, role: meP.role };
  if (meP.role === "werewolf") {
    you.wolves = g.players.filter((p) => p && p.role === "werewolf").map((p) => p.seat);
    if (g.phase === "night" && meP.alive && g.night && g.night.blade != null) you.blade = g.night.blade;
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
  return you;
}

/** 单机本地构造与联机快照同形的视图（ui.js 不区分两种来源）。 */
function soloSnap() {
  const g = solo.state;
  const night = g.phase === "night";
  const revealed = g.phase === "revealed";
  const meP = g.players[0]; // 单机真人恒为 1 号
  const spectator = g.phase !== "lobby" && !revealed && !meP.alive;
  const pending = g.phase === "night" || g.phase === "day" ? game.pendingSeat(g) : null;
  const s = {
    solo: true,
    code: null,
    mySeat: 1,
    phase: g.phase,
    day: g.day,
    players: g.players.map((p) => {
      const e = { seat: p.seat, nick: p.nick, isAI: !!p.isAI, alive: !!p.alive };
      if (revealed || spectator || p.seat === 1) {
        e.role = p.role;
        if (p.death) e.death = p.death;
      }
      return e;
    }),
    events: solo.log,
    you: privateOf(g, 1),
  };
  if (!night) {
    s.subPhase = g.subPhase; // §4.1.6：夜里不露子阶段
    if (pending != null) s.pending = pending;
    if (g.pkCandidates) s.pkCandidates = g.pkCandidates;
  }
  if (revealed) {
    s.winner = g.winner;
    s.reason = g.reason;
  }
  if (pending === 1 && ai.phaseOf(g)) s.action = { kind: ai.phaseOf(g) };
  return s;
}

function startSolo(nick) {
  const uid = net.me().uid;
  let r = game.advance(game.createInitialState(), { type: "join", nick, uid });
  if (r.error) return ui.toast(r.error);
  r = game.advance(r.state, { type: "ready", seat: 1, ready: true });
  r = game.advance(r.state, { type: "start", seed: crypto.getRandomValues(new Uint32Array(1))[0] | 0, solo: true });
  if (r.error) return ui.toast(r.error);
  mode = "solo";
  solo = { state: r.state, log: [], driving: false };
  saveSolo();
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
  speak: (text) => soloSubmit({ type: "speak", seat: 1, text }),
  vote: (target) => soloSubmit({ type: "vote", seat: 1, target }),
  wolfTarget: (target) => soloSubmit({ type: "wolf_target", seat: 1, target }),
  seerCheck: (target) => soloSubmit({ type: "seer_check", seat: 1, target }),
  witchSave: () => soloSubmit({ type: "witch_move", seat: 1, move: "save" }),
  witchPoison: (target) => soloSubmit({ type: "witch_move", seat: 1, move: "poison", target }),
  witchSkip: () => soloSubmit({ type: "witch_move", seat: 1, move: "skip" }),
  hunterShoot: (target) => soloSubmit({ type: "hunter_shoot", seat: 1, target }),
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
      renderSolo();
      const { action } = await ai.decideFor(g, solo.log, pending); // buildMessages → /api/ai-proxy → 解析
      let r = action ? game.advance(solo.state, action) : { error: "ai-failed" };
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
  if (solo && solo.state.phase === "revealed") enterRevealed(soloSnap());
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
}

async function submitAct(action, body) {
  const r = await net.act(action, body);
  if (r && r.error) ui.toast(String(r.error));
  return r;
}

const onlineActions = {
  speak: (text) => submitAct("speak", { text }),
  vote: (target) => submitAct("vote", { target }),
  wolfTarget: (target) => submitAct("wolf-target", { target }),
  seerCheck: (target) => submitAct("seer-check", { target }),
  witchSave: () => submitAct("witch-move", { move: "save" }),
  witchPoison: (target) => submitAct("witch-move", { move: "poison", target }),
  witchSkip: () => submitAct("witch-move", { move: "skip" }),
  hunterShoot: (target) => submitAct("hunter-shoot", { target }),
};

/* ---- 房主驱动 AI（§7.6：快照 owner == me 才驱动） ----
 * 夜里房主自己的快照也是冻结的（§4.1.6），驱动不能依赖快照变化，
 * 故除快照触发外另有一个 4s 兜底节拍；drive_ai 在无 AI 待行动时回错即停。
 * 房主没配 AI 时不空转：DO 的 150s 行动超时回退兜底（§5.11）。 */

let aiTimer = null;
let aiDriving = false;

function maybeDriveAI(s) {
  if (mode !== "online" || !s) return;
  if (s.owner !== net.me().uid) return;
  if (s.phase !== "night" && s.phase !== "day") return;
  if (!ai.hasConfig()) return;
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
    const cfg = ai.loadConfig();
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
      go(target, { "screen-solo": "单机开局", "screen-online": "联机房间", "screen-settings": "AI 设置" }[target] || "");
    });
  }

  /* 单机开局（开始游戏 = 不可逆，两步确认，§1） */
  $("solo-start").addEventListener("click", () => {
    const nick = takeNick("solo-nick");
    if (!nick) return;
    if (!ai.hasConfig()) ui.toast("未配置 AI 接口：AI 将使用兜底发言与随机行动（可在 AI 设置里配置）");
    ui.showConfirm(`以「${nick}」开始单机对局（你 + 8 个 AI）`, () => startSolo(nick));
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
    const text =
      empty > 0
        ? `将补 ${empty} 个 AI 补足 9 人开局（以提交瞬间房间实况为准）` // §7.4：N 只是预估
        : "9 人满员，确认开局";
    ui.showConfirm(text, async () => {
      const r = await submitAct("start");
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
    ai.saveConfig({ baseUrl, key: $("cfg-key").value, model: $("cfg-model").value });
    ui.toast("已保存（只存本机浏览器）");
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

  /* 断线重连 / 刷新恢复（§2：localStorage 固定身份） */
  const s = loadSolo();
  if (s) {
    mode = "solo";
    solo = { state: s.state, log: s.log, driving: false };
    if (solo.state.phase === "revealed") enterRevealed(soloSnap());
    else {
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
