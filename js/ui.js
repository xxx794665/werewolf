/* ============================================================
 * js/ui.js —— DOM 渲染与交互辅助（只读快照渲染，不碰网络）
 * ------------------------------------------------------------
 * 职责：
 *   - 渲染：大厅座位、对局（身份卡 / 阶段条 / 事件流 / 座位网格 / 行动面板）、
 *     终局复盘。输入永远是「按座位裁剪后的快照」（联机 = DO snapshotFor，
 *     单机 = app.js 本地构造的同形快照），本模块不区分两种来源。
 *   - 两步确认条：showConfirm(text, onSubmit) / hideConfirm()——不可逆操作
 *     （定刀 / 解药 / 毒药 / 开枪 / 投票 / PK 投票 / 开始）一律
 *     「选择 → 底部固定确认条（热区 ≥44px）→ 提交」（features.md §1）。
 *   - toast：只定位移动画，禁止 from-opacity 入场（透明拦截点击，§1）。
 *   - 顶栏滚动收拢：滚动 >60px 给 #topbar 加 .is-collapsed。
 * 安全：玩家昵称与 AI 发言是不可信文本，一律 textContent，绝不 innerHTML；
 *   innerHTML 只用于本仓库 icons.js 的 SVG 常量。
 * node --test 可 import（顶层不碰 document）。
 * ============================================================ */

import { icon, iconEl } from "./icons.js";

export const ROLE_NAME = { werewolf: "狼人", villager: "平民", seer: "预言家", witch: "女巫", hunter: "猎人" };
const ROLE_ICON = { werewolf: "wolf", villager: "villager", seer: "seer", witch: "witch", hunter: "hunter" };
const SUBPHASE_NAME = {
  night_hunter: "猎人翻牌",
  lastwords: "遗言",
  speak: "依次发言",
  vote: "放逐投票",
  pk_speak: "PK 发言",
  pk_vote: "PK 投票",
  exile_lastwords: "放逐遗言",
  hunter: "猎人翻牌",
};
const DEATH_CAUSE = { blade: "夜里被刀", poison: "夜里被毒", shot: "被猎人带走", exile: "被放逐" };

/* ---------- 小工具（全部 textContent，不接 HTML） ---------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function badge(cls, iconName, text) {
  const b = el("span", "badge " + cls);
  if (iconName) b.append(iconEl(iconName));
  b.append(el("span", null, text));
  return b;
}

const $ = (id) => document.getElementById(id);

function seatNick(snap, seat) {
  const p = snap.players[seat - 1];
  return p ? p.nick : "";
}

/** 「5 号（阿明）」式座位称呼（无昵称时只显示座位号）。 */
function seatLabel(snap, seat) {
  const nick = seatNick(snap, seat);
  return nick ? `${seat} 号（${nick}）` : `${seat} 号`;
}

/* ---------- 屏幕切换与顶栏 ---------- */

export function show(screenId) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screenId;
  window.scrollTo(0, 0);
}

export function setSubtitle(text) {
  const sub = $("topbar-sub");
  if (sub) sub.textContent = text || "";
}

export function initTopbar() {
  const bar = $("topbar");
  if (!bar) return;
  /* 吸顶状态条的 top 偏移跟随顶栏实际高度（收拢时变矮），写入 CSS 变量 */
  const syncHeight = () =>
    document.documentElement.style.setProperty("--topbar-h", bar.offsetHeight + "px");
  const onScroll = () => {
    bar.classList.toggle("is-collapsed", window.scrollY > 60);
    syncHeight();
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", syncHeight);
  onScroll();
}

/* ---------- 吸顶状态条倒计时（联机白天：行动超时 150s 倒数，§5.11） ----------
 * renderPhaseBanner 每次快照重渲染时重置 countdownAt；本 ticker 每秒只改
 * 倒计时 span 的文本，不做整屏重渲染。无倒计时（单机 / 夜里）时自解码为隐藏。 */
let countdownAt = null;
let countdownEl = null;
let countdownTicker = null;

function tickCountdown() {
  if (!countdownEl || !countdownEl.isConnected) {
    countdownEl = null;
    countdownAt = null;
    return;
  }
  const left = Math.max(0, Math.ceil((countdownAt - Date.now()) / 1000));
  countdownEl.textContent = left > 0 ? `剩 ${left} 秒` : "结算中…";
}

function armCountdown(span, endsAt) {
  countdownEl = span;
  countdownAt = endsAt;
  if (!countdownTicker) countdownTicker = setInterval(tickCountdown, 1000);
  tickCountdown();
}

/* ---------- toast（位移入场，禁 from-opacity） ---------- */

let toastTimer = null;
export function toast(msg) {
  let t = $("toast");
  if (!t) {
    t = el("div", "toast");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add("is-show"); /* 只动 transform，见 style.css */
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-show"), 3000);
}

/* ---------- 两步确认条（底部固定，热区 ≥44px） ---------- */

let confirmFn = null;

export function showConfirm(text, onSubmit) {
  const bar = $("confirm-bar");
  $("confirm-selection").textContent = text;
  confirmFn = onSubmit;
  bar.hidden = false;
}

export function hideConfirm() {
  const bar = $("confirm-bar");
  if (bar) bar.hidden = true;
  confirmFn = null;
}

export function initConfirmBar() {
  $("confirm-submit").addEventListener("click", () => {
    const fn = confirmFn;
    hideConfirm();
    if (fn) fn();
  });
}

/* ---------- 大厅 ---------- */

export function renderLobby(snap, opts) {
  const list = $("lobby-seats");
  list.textContent = "";
  for (let seat = 1; seat <= 9; seat++) {
    const p = snap.players[seat - 1];
    const li = el("li", "seat");
    if (!p) {
      li.classList.add("seat-empty");
      li.append(el("span", "seat-no", `${seat}`), el("span", "seat-nick", "待加入"));
    } else {
      /* 快照不携带 uid（按座位裁剪）：房主恒为 1 号（createRoom 入座 1 号，
       * worker/src/room-logic.js），「我」用 snap.mySeat 判断 */
      if (p.seat === snap.mySeat) li.classList.add("seat-me");
      li.append(el("span", "seat-no", `${seat}`), el("span", "seat-nick", p.nick));
      const badges = el("span", "seat-badges");
      if (p.seat === 1) badges.append(badge("badge-owner", "crown", "房主"));
      if (p.seat === snap.mySeat) badges.append(badge("badge-me", null, "我"));
      badges.append(badge(p.ready ? "badge-ok" : "badge-muted", p.ready ? "check" : null, p.ready ? "已准备" : "未准备"));
      li.append(badges);
    }
    list.append(li);
  }
  const codeLine = $("room-code-line");
  if (snap.code && !snap.solo) {
    codeLine.hidden = false;
    $("room-code").textContent = snap.code;
  } else {
    codeLine.hidden = true;
  }
  const readyBtn = $("btn-ready");
  const meP = snap.players[snap.mySeat - 1];
  readyBtn.textContent = meP && meP.ready ? "取消准备" : "准备";
  const startBtn = $("btn-start");
  startBtn.hidden = !opts.isOwner;
  startBtn.disabled = !opts.canStart;
}

/* ---------- 对局：阶段条 / 身份卡 / 事件流 / 座位 / 行动面板 ---------- */

function renderPhaseBanner(snap) {
  const box = $("phase-banner");
  box.textContent = "";
  if (snap.phase === "night") {
    /* §4.1.6：夜里只露「第 N 夜」，不露子阶段与轮到谁 */
    box.append(iconEl("moon"), el("span", null, ` 第 ${snap.day} 夜`));
    box.append(el("span", "phase-sub", snap.action ? "轮到你行动" : "夜晚进行中"));
  } else if (snap.phase === "day") {
    box.append(iconEl("sun"), el("span", null, ` 第 ${snap.day} 天`));
    const sub = el("span", "phase-sub");
    const parts = [SUBPHASE_NAME[snap.subPhase] || ""];
    if (snap.pending != null) {
      parts.push(snap.pending === snap.mySeat ? "轮到你" : `轮到 ${snap.pending} 号`);
    }
    sub.append(el("span", null, parts.filter(Boolean).join(" · ")));
    /* 行动倒计时（仅联机白天带 deadline，§5.11；单机恒无） */
    if (snap.deadline && snap.deadline.at) {
      sub.append(el("span", null, " · "));
      const cd = el("span", "phase-countdown");
      sub.append(cd);
      armCountdown(cd, snap.deadline.at);
    }
    box.append(sub);
  } else {
    box.append(el("span", null, "对局"));
  }
}

function renderIdCard(snap) {
  const card = $("idcard");
  card.textContent = "";
  const you = snap.you;
  if (!you) return;
  const head = el("div", "idcard-head");
  head.append(iconEl(ROLE_ICON[you.role] || "villager"));
  head.append(el("strong", null, `${you.seat} 号 · ${ROLE_NAME[you.role] || "未知"}`));
  if (!you.alive) head.append(badge("badge-muted", "skull", "已出局 · 观战"));
  card.append(head);
  const lines = [];
  if (you.role === "werewolf" && you.wolves) {
    lines.push(`狼队友：${you.wolves.filter((s) => s !== you.seat).map((s) => `${s} 号`).join("、") || "无（你是最后一狼）"}`);
  }
  if (you.role === "seer" && you.checks && you.checks.length) {
    lines.push("验人记录：" + you.checks.map((c) => `第${c.night}夜 ${c.seat}号是${c.result === "wolf" ? "狼人" : "好人"}`).join("；"));
  }
  if (you.role === "witch") {
    lines.push(`解药${you.antidote ? "未用" : "已用"} · 毒药${you.poison ? "未用" : "已用"}`);
  }
  if (you.blade != null && snap.phase === "night") {
    lines.push(you.role === "witch" ? `今夜刀口：${seatLabel(snap, you.blade)}` : `今夜刀口已定：${seatLabel(snap, you.blade)}`);
  }
  for (const t of lines) card.append(el("p", "idcard-line", t));
}

function renderLog(snap) {
  const box = $("log");
  box.textContent = "";
  const events = (snap.events || []).slice(-200); // 防长局 DOM 膨胀
  for (const ev of events) {
    box.append(logItem(snap, ev));
  }
}

function logItem(snap, ev) {
  switch (ev.t) {
    case "deaths":
      return el("li", "ev ev-deaths", ev.seats && ev.seats.length
        ? `天亮公布：昨晚 ${ev.seats.map((s) => seatLabel(snap, s)).join("、")} 死亡（不翻牌）。`
        : "天亮公布：昨晚是平安夜，无人死亡。");
    case "speech":
      return el("li", "ev ev-speech", `${seatLabel(snap, ev.seat)}：${ev.text}`);
    case "lastwords":
      return el("li", "ev ev-lastwords", `${seatLabel(snap, ev.seat)}（遗言）：${ev.text}`);
    case "pk_speak":
      return el("li", "ev ev-pk", `${seatLabel(snap, ev.seat)}（PK 发言）：${ev.text}`);
    case "tie":
      return el("li", "ev ev-sys", `投票平票：${ev.seats.map((s) => `${s} 号`).join("、")} 进入 PK。`);
    case "vote":
      return el("li", "ev ev-vote", `投票：${ev.voter} 号 → ${ev.target == null ? "弃票" : `${ev.target} 号`}`);
    case "exile":
      return el("li", "ev ev-sys", ev.seat == null ? "放逐结果：无人出局（平安日）。" : `放逐结果：${seatLabel(snap, ev.seat)} 出局。`);
    case "hunter":
      return el("li", "ev ev-hunter", ev.target == null
        ? `${ev.seat} 号翻牌猎人，放弃开枪。`
        : `${ev.seat} 号翻牌猎人，开枪带走 ${seatLabel(snap, ev.target)}（无遗言、不翻牌）。`);
    case "digest":
      return el("li", "ev ev-sys", `【第 ${ev.day} 天摘要】${ev.text}`);
    default:
      return el("li", "ev ev-sys", "");
  }
}

function renderSeats(snap) {
  const grid = $("game-seats");
  grid.textContent = "";
  for (const p of snap.players) {
    if (!p) continue;
    const li = el("li", "seat");
    if (!p.alive) li.classList.add("seat-dead");
    if (p.seat === snap.mySeat) li.classList.add("seat-me");
    li.append(el("span", "seat-no", `${p.seat}`), el("span", "seat-nick", p.nick));
    const badges = el("span", "seat-badges");
    if (p.role && ROLE_NAME[p.role]) badges.append(badge("badge-role", ROLE_ICON[p.role], ROLE_NAME[p.role]));
    if (p.isAI) badges.append(badge("badge-muted", "robot", "AI"));
    if (p.hosted) badges.append(badge("badge-warn", "robot", "托管"));
    if (p.seat === snap.mySeat) badges.append(badge("badge-me", null, "我"));
    if (!p.alive) badges.append(badge("badge-muted", "skull", "出局"));
    li.append(badges);
    grid.append(li);
  }
}

/* ---------- 行动面板（两步确认：选择 → 底部确认条 → 提交） ---------- */

function aliveSeatList(snap) {
  return snap.players.filter((p) => p && p.alive).map((p) => p.seat);
}

/** 座位选择按钮组；点选 → showConfirm(label, submit)。 */
function targetPicker(panel, snap, seats, makeLabel, onSubmit, marks) {
  const wrap = el("div", "target-grid");
  for (const seat of seats) {
    const b = el("button", "btn target-btn", seatLabel(snap, seat));
    b.type = "button";
    const mark = marks && marks[seat];
    if (mark) {
      b.append(badge("badge-muted", null, mark.text));
      if (mark.disabled) b.disabled = true;
    }
    b.addEventListener("click", () => {
      for (const x of wrap.querySelectorAll(".target-btn")) x.classList.remove("is-selected");
      b.classList.add("is-selected");
      showConfirm(`${makeLabel(seat)} —— 确认后不可更改`, () => onSubmit(seat));
    });
    wrap.append(b);
  }
  panel.append(wrap);
}

/** 直接出一个走确认条的按钮（弃票 / 跳过 / 放弃开枪 / 解药）。 */
function confirmButton(panel, text, label, onSubmit, cls) {
  const b = el("button", "btn " + (cls || ""), text);
  b.type = "button";
  b.addEventListener("click", () => showConfirm(`${label} —— 确认后不可更改`, onSubmit));
  panel.append(b);
}

function renderAction(snap, actions) {
  const panel = $("action-panel");
  panel.textContent = "";
  const kind = snap.action && snap.action.kind;
  const you = snap.you;
  const meSeat = snap.mySeat;

  if (snap.phase === "night" && !kind) {
    panel.append(el("p", "hint", "夜晚进行中。其他人的夜间行动对你不可见，天亮后统一公布结果。"));
    return;
  }
  if (!kind) {
    if (snap.waitingOwner) {
      panel.append(el("p", "hint", "等待房主驱动 AI（房主暂时掉线，恢复后自动继续）。"));
    } else if (you && !you.alive) {
      panel.append(el("p", "hint", "你已出局，观战中（全员身份仅你可见）。"));
    } else if (snap.pending != null) {
      panel.append(el("p", "hint", `等待 ${seatLabel(snap, snap.pending)} 行动…`));
    } else {
      panel.append(el("p", "hint", "等待中…"));
    }
    return;
  }

  const alive = aliveSeatList(snap);
  switch (kind) {
    case "speak":
    case "lastwords":
    case "pk_speak": {
      const title = kind === "speak" ? "轮到你发言" : kind === "lastwords" ? "发表你的遗言" : "你在 PK 台上，做自辩发言";
      panel.append(el("p", "action-title", `${title}（不超过 200 字）`));
      const ta = el("textarea", "speech-input");
      ta.maxLength = 200;
      ta.rows = 4;
      ta.placeholder = "说点什么…";
      const counter = el("p", "hint counter", "0 / 200");
      ta.addEventListener("input", () => {
        counter.textContent = `${ta.value.length} / 200`;
      });
      const send = el("button", "btn btn-primary", "提交发言"); /* 发言不在不可逆清单（§1），单步提交 */
      send.type = "button";
      send.addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) {
          toast("发言不能为空");
          return;
        }
        actions.speak(text);
      });
      panel.append(ta, counter, send);
      break;
    }
    case "vote": {
      panel.append(el("p", "action-title", "放逐投票：选出你认为最该出局的人（或弃票）"));
      targetPicker(panel, snap, alive.filter((s) => s !== meSeat), (s) => `投票给 ${seatLabel(snap, s)}`, actions.vote);
      confirmButton(panel, "弃票", "本轮弃票", () => actions.vote(null));
      break;
    }
    case "pk_vote": {
      const seats = snap.pkCandidates || [];
      panel.append(el("p", "action-title", `PK 投票：只能投 ${seats.join("、")} 号，或弃票`));
      targetPicker(panel, snap, seats, (s) => `PK 投票给 ${seatLabel(snap, s)}`, actions.vote);
      confirmButton(panel, "弃票", "本轮弃票", () => actions.vote(null));
      break;
    }
    case "wolf": {
      panel.append(el("p", "action-title", "狼队密聊（只有狼人可见）· 投票定刀"));
      /* §4.1.1 密聊记录：狼座私有快照字段，轮询实时刷新 */
      const chat = you && Array.isArray(you.wolfChat) ? you.wolfChat : [];
      const chatBox = el("ul", "wolf-chat");
      if (chat.length === 0) chatBox.append(el("li", "wolf-chat-line wolf-chat-empty", "今晚队友还没说话，开个头？"));
      for (const m of chat) {
        chatBox.append(el("li", "wolf-chat-line" + (m.seat === meSeat ? " me" : ""), `${m.seat} 号：${m.text}`));
      }
      panel.append(chatBox);
      /* 密聊输入：单步提交（同白天发言，不在不可逆清单） */
      const row = el("div", "chat-input-row");
      const input = el("input", "chat-input");
      input.maxLength = 60;
      input.placeholder = "对队友说点什么（≤60 字）…";
      const send = el("button", "btn", "发送");
      send.type = "button";
      const sendChat = () => {
        const text = input.value.trim();
        if (!text) return toast("密聊内容不能为空");
        input.value = "";
        actions.wolfChat(text);
      };
      send.addEventListener("click", sendChat);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendChat();
      });
      row.append(input, send);
      panel.append(row);
      /* 投票定刀：下拉框选当前存活目标（全员一票不可改，平票狼队长裁定；
       * 允许投队友 / 自己——自刀与弃车是合法战术，§8.4 同口径） */
      const votes = (you && you.wolfVotes) || {};
      if (votes[meSeat] !== undefined) {
        const capNote = you.captain === meSeat ? "平票时由你一锤定音。" : "";
        panel.append(el("p", "hint", `你已投 ${seatLabel(snap, votes[meSeat])}（不可更改）。等待其他狼人投票…${capNote}`));
      } else {
        const wrap = el("div", "wolf-vote-row");
        const sel = el("select", "vote-select");
        sel.setAttribute("aria-label", "选择刀口目标");
        for (const s of alive) {
          const o = el("option", null, seatLabel(snap, s) + (s === meSeat ? "（自己）" : ""));
          o.value = String(s);
          sel.append(o);
        }
        const cast = el("button", "btn btn-primary", "投票定刀");
        cast.type = "button";
        cast.addEventListener("click", () => {
          const t = Number(sel.value);
          showConfirm(`投票刀 ${seatLabel(snap, t)} —— 确认后不可更改`, () => actions.wolfTarget(t));
        });
        wrap.append(sel, cast);
        panel.append(wrap);
        panel.append(el("p", "hint", "全员投票定刀：最高票出局，平票由狼队长裁定。"));
      }
      break;
    }
    case "seer": {
      panel.append(el("p", "action-title", "预言家验人：选择一名存活玩家查验"));
      const checked = new Set((you.checks || []).map((c) => c.seat));
      const marks = {};
      for (const s of alive) {
        if (s === meSeat) marks[s] = { text: "自己", disabled: true };
        else if (checked.has(s)) marks[s] = { text: "已验", disabled: true };
      }
      targetPicker(panel, snap, alive, (s) => `查验 ${seatLabel(snap, s)}`, actions.seerCheck, marks);
      break;
    }
    case "witch": {
      panel.append(el("p", "action-title", "女巫行动（同晚至多用一瓶药）"));
      if (you.antidote && you.blade != null) {
        panel.append(el("p", "hint", `今夜刀口：${seatLabel(snap, you.blade)}`));
        const selfBlocked = snap.day > 1 && you.blade === meSeat;
        if (selfBlocked) {
          panel.append(el("p", "hint", "刀口是你自己，但已过首夜，规则禁止自救。"));
        } else {
          confirmButton(panel, `用解药救 ${you.blade} 号`, `用解药救 ${seatLabel(snap, you.blade)}`, actions.witchSave, "btn-primary");
        }
      } else if (!you.antidote) {
        panel.append(el("p", "hint", "解药已用完，夜里不再向你显示刀口。"));
      }
      if (you.poison) {
        panel.append(el("p", "action-title", "或用毒药（毒错好人代价极大）："));
        targetPicker(panel, snap, alive.filter((s) => s !== meSeat), (s) => `用毒药毒 ${seatLabel(snap, s)}`, actions.witchPoison);
      }
      confirmButton(panel, "什么都不做（跳过）", "今晚不用药", actions.witchSkip);
      break;
    }
    case "hunter": {
      panel.append(el("p", "action-title", "你触发了猎人翻牌：可以开枪带走 1 名存活玩家，或放弃"));
      targetPicker(panel, snap, alive, (s) => `开枪带走 ${seatLabel(snap, s)}`, (s) => actions.hunterShoot(s));
      confirmButton(panel, "放弃开枪", "放弃开枪", () => actions.hunterShoot(null));
      break;
    }
    default:
      panel.append(el("p", "hint", "等待中…"));
  }
}

/** 对局整屏渲染。actions 见 app.js（单机本地提交 / 联机 act 提交共用此形状）。 */
export function renderGame(snap, actions) {
  renderPhaseBanner(snap);
  renderIdCard(snap);
  renderLog(snap);
  renderSeats(snap);
  renderAction(snap, actions);
}

/* ---------- 终局复盘（revealed：唯一全员亮牌时机，§5.5） ---------- */

export function renderRevealed(snap) {
  $("result-title").textContent =
    snap.winner === "good" ? "好人胜利" : snap.winner === "wolf" ? "狼人胜利" : "终局";
  const list = $("reveal-list");
  list.textContent = "";
  if (snap.reason) {
    list.append(el("li", "reveal-item reveal-reason", snap.reason === "wolves-eliminated" ? "狼人全部出局。" : "狼人数量已不少于好人（屠城）。"));
  }
  for (const p of snap.players) {
    if (!p) continue;
    const li = el("li", "reveal-item");
    li.append(iconEl(ROLE_ICON[p.role] || "villager"));
    const text = p.alive
      ? `${p.seat} 号 ${p.nick} · ${ROLE_NAME[p.role] || "?"} · 存活`
      : `${p.seat} 号 ${p.nick} · ${ROLE_NAME[p.role] || "?"} · 出局（第 ${p.death ? p.death.day : "?"} 天${p.death ? DEATH_CAUSE[p.death.cause] || "" : ""}）`;
    li.append(el("span", null, text));
    if (p.isAI) li.append(badge("badge-muted", "robot", "AI"));
    list.append(li);
  }
}
