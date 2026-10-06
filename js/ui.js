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
 *   - 玩家标签：座位行内私人笔记（预置 + 自定义，只存 localStorage，
 *     生命周期 = 所属对局），renderSeats 内联编辑器；编辑器展开期间冻结座位
 *     网格重建，保住输入草稿与软键盘焦点（否则 1.5s 重渲染销毁 input 节点）。
 *   - 投票记录卡（§5.14）：voteHistory 纯函数把公开事件流按天 / 轮次重组成
 *     票型速查，renderVoteHistory 渲染折叠卡（仿狼队密聊卡，纯前端重组）。
 *   - 日志按天折叠（2026-10-05 试玩反馈）：groupLogEvents 纯函数按天分组
 *     （成对 exile{null} 跳过），renderLog 渲染为每天一个 <details>——最新一天
 *     默认展开、更早收起，手动开合按天记忆、跨 1.5s 快照重建不丢。
 * 安全：玩家昵称与 AI 发言是不可信文本，一律 textContent，绝不 innerHTML；
 *   innerHTML 只用于本仓库 icons.js 的 SVG 常量。
 * node --test 可 import（顶层不碰 document）。
 * ============================================================ */

import { icon, iconEl } from "./icons.js";
import { BOARDS, isWolf } from "../shared/game.js"; // §1.1 板子注册表 / §1.2 判狼口径（ADR-0013）
import { aggregateStats } from "./archive.js"; // §3.3 战绩汇总（ADR-0015）

/* §1.2–1.4（ADR-0013）三新角色：狼王图复用狼头（处处视作狼），守卫 / 白痴复用现有图标 */
export const ROLE_NAME = {
  werewolf: "狼人", villager: "平民", seer: "预言家", witch: "女巫", hunter: "猎人",
  wolfking: "狼王", guard: "守卫", idiot: "白痴",
};
const ROLE_ICON = {
  werewolf: "wolf", villager: "villager", seer: "seer", witch: "witch", hunter: "hunter",
  wolfking: "wolf", guard: "check", idiot: "villager",
};
const SUBPHASE_NAME = {
  night_hunter: "猎人翻牌",
  lastwords: "遗言",
  speak: "依次发言",
  vote: "放逐投票",
  pk_speak: "PK 发言",
  pk_vote: "PK 投票",
  exile_lastwords: "放逐遗言",
  hunter: "猎人翻牌",
  /* §2.6（ADR-0014）警长竞选与警徽流 + §1.3 守卫（夜里不露子阶段，guard 仅为兜底键） */
  guard: "守卫守护",
  elect_join: "上警表态",
  elect_withdraw: "退水表态",
  elect_campaign: "竞选发言",
  elect_vote: "警长投票",
  elect_pk_speak: "竞选 PK 发言",
  elect_pk_vote: "警长 PK 投票",
  badge: "警徽处置",
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

/* ---------- 吸顶状态条倒计时（§5.11 行动超时 150s 倒数） ----------
 * 白天全员可见（快照 deadline {at, seat}）；夜里仅行动者本人快照带 deadline
 * （无泄漏），有则同样显示。renderPhaseBanner 每次快照重渲染时重置 countdownAt；
 * 本 ticker 每秒只改倒计时 span 的文本，不做整屏重渲染。无倒计时（单机真人
 * 行动 / 夜里非行动者）时自解码为隐藏。 */
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
    const sub = el("span", "phase-sub", snap.action ? "轮到你行动" : "夜晚进行中");
    /* 行动倒计时：夜里仅行动者本人的快照带 deadline（行动者本就知道轮到自己，无泄漏） */
    if (snap.deadline && snap.deadline.at) {
      sub.append(el("span", null, " · "));
      const cd = el("span", "phase-countdown");
      sub.append(cd);
      armCountdown(cd, snap.deadline.at);
    }
    box.append(sub);
  } else if (snap.phase === "day") {
    box.append(iconEl("sun"), el("span", null, ` 第 ${snap.day} 天`));
    const sub = el("span", "phase-sub");
    const parts = [SUBPHASE_NAME[snap.subPhase] || ""];
    if (snap.pending != null) {
      parts.push(snap.pending === snap.mySeat ? "轮到你" : `轮到 ${snap.pending} 号`);
    }
    /* §2.5（ADR-0014）警长座位全程公开：白天子行追加（判空容错旧局快照） */
    if (snap.sheriff && snap.sheriff.seat != null) parts.push(`警长 ${snap.sheriff.seat} 号`);
    sub.append(el("span", null, parts.filter(Boolean).join(" · ")));
    /* 行动倒计时（仅联机白天带 deadline，§5.11；单机恒无） */
    if (snap.deadline && snap.deadline.at) {
      sub.append(el("span", null, " · "));
      const cd = el("span", "phase-countdown");
      sub.append(cd);
      armCountdown(cd, snap.deadline.at);
    }
    box.append(sub);
    /* §2.5 竞选公开信息（snap.election：举手 / 候选 / PK 台名单）在阶段区第二行可见 */
    if (snap.election) {
      const eln = snap.election;
      const seg = [];
      if (eln.stage === "join") {
        seg.push(eln.run ? `上警表态中（已表态 ${Object.keys(eln.run).length} 人）` : "上警表态中");
      }
      if (eln.candidates && eln.candidates.length) seg.push(`候选 ${eln.candidates.join("、")} 号`);
      if (eln.stage === "withdraw") seg.push("退水表态中");
      if (eln.pkCandidates && eln.pkCandidates.length) seg.push(`PK 台 ${eln.pkCandidates.join("、")} 号`);
      if (seg.length) box.append(el("div", "phase-election", `警长竞选：${seg.join(" · ")}`));
    }
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
  if (isWolf(you.role) && you.wolves) { // §1.2（ADR-0013）狼王同狼口径：也知全体队友
    lines.push(`狼队友：${you.wolves.filter((s) => s !== you.seat).map((s) => `${s} 号`).join("、") || "无（你是最后一狼）"}`);
  }
  if (you.role === "seer" && you.checks && you.checks.length) {
    lines.push("验人记录：" + you.checks.map((c) => `第${c.night}夜 ${c.seat}号是${c.result === "wolf" ? "狼人" : "好人"}`).join("；"));
  }
  if (you.role === "witch") {
    lines.push(`解药${you.antidote ? "未用" : "已用"} · 毒药${you.poison ? "未用" : "已用"}`);
  }
  if (you.role === "guard" && you.guardLast != null) {
    lines.push(`上晚守护：${you.guardLast} 号（今晚不可再守同一人）`); // §1.3 连守限制提示
  }
  if (you.idiotRevealed) {
    lines.push("你已翻牌白痴：存活但失去投票权（仍可发言）。"); // §1.4 本人提示
  }
  if (you.blade != null && snap.phase === "night") {
    lines.push(you.role === "witch" ? `今夜刀口：${seatLabel(snap, you.blade)}` : `今夜刀口已定：${seatLabel(snap, you.blade)}`);
  }
  for (const t of lines) card.append(el("p", "idcard-line", t));
}

/* ---------- 日志按天折叠（2026-10-05 试玩反馈）----------
 * 手动开合状态按天记忆：渲染默认「最新一天展开、更早收起」，手动开合永远优先，
 * 跨 1.5s 快照重建不丢；天数较上次回退 = 新对局，记忆清零。
 * 开合记在 summary 的 click（程序化改 .open 不触发 click，重渲染不污染手动状态；
 * 键盘 Enter/Space 在 summary 上同样派发 click）。 */

let logDayOpen = new Map(); // day -> open（仅手动开合过才写入）
let logMaxDay = 0;

/** 公开事件流 → [{ day, events: [...] }]（纯函数，node --test 可验）：
 * 组按 day 升序、组内保持事件流原序；主投票平票进 PK 时成对落下的
 * exile{null}（§1.3 schema 不动）在此跳过——并非平安日，票型已由 tie 行表达。 */
export function groupLogEvents(events) {
  const groups = [];
  for (let i = 0; i < (events || []).length; i++) {
    const ev = events[i];
    const prev = events[i - 1];
    if (ev.t === "exile" && ev.seat == null && prev && prev.t === "tie" && prev.day === ev.day) continue;
    let g = groups[groups.length - 1];
    if (!g || g.day !== ev.day) {
      g = { day: ev.day, events: [] };
      groups.push(g);
    }
    g.events.push(ev);
  }
  return groups;
}

function renderLog(snap) {
  const box = $("log");
  box.textContent = "";
  const groups = groupLogEvents((snap.events || []).slice(-200)); // 防长局 DOM 膨胀
  const latestDay = groups.length ? groups[groups.length - 1].day : 0;
  if (latestDay < logMaxDay) logDayOpen.clear(); // 天数回退 = 新对局
  logMaxDay = Math.max(logMaxDay, latestDay);
  for (const g of groups) {
    const det = el("details", "log-day");
    det.open = logDayOpen.has(g.day) ? logDayOpen.get(g.day) : g.day === latestDay;
    const head = el("summary", "log-day-head", `第 ${g.day} 天 · ${g.events.length} 条`);
    head.addEventListener("click", () => logDayOpen.set(g.day, !det.open));
    det.append(head);
    const list = el("ul", "log-day-list");
    for (const ev of g.events) list.append(logItem(snap, ev));
    det.append(list);
    box.append(det);
  }
}

function logItem(snap, ev) {  switch (ev.t) {
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
      /* §1.5（ADR-0013）白痴翻牌免死：不计入死亡名单，存活但失去投票权 */
      if (ev.idiot) return el("li", "ev ev-sys", `放逐结果：${seatLabel(snap, ev.seat)} 翻牌白痴，放逐无效（存活但失去投票权）。`);
      return el("li", "ev ev-sys", ev.seat == null ? "放逐结果：无人出局（平安日）。" : `放逐结果：${seatLabel(snap, ev.seat)} 出局。`);
    case "hunter": {
      /* §1.5（ADR-0013）狼王放逐翻牌：role 缺省按猎人渲染（向后兼容旧日志） */
      const who = ev.role === "wolfking" ? "狼王" : "猎人";
      return el("li", "ev ev-hunter", ev.target == null
        ? `${ev.seat} 号翻牌${who}，放弃开枪。`
        : `${ev.seat} 号翻牌${who}，开枪带走 ${seatLabel(snap, ev.target)}（无遗言、不翻牌）。`);
    }
    /* ---------- 警长竞选与警徽流（§2.5 / 附录 t-schema 最终版，ADR-0014） ---------- */
    case "elect_run":
      return el("li", "ev ev-sys", `上警表态：${ev.seat} 号${ev.run ? "上警参选" : "不上警"}。`);
    case "elect_withdraw":
      return el("li", "ev ev-sys", `退水表态：${ev.seat} 号${ev.quit ? "退水，退出竞选" : "留在台上"}。`);
    case "elect_speech":
      return el("li", "ev ev-speech", `${seatLabel(snap, ev.seat)}（竞选发言）：${ev.text}`);
    case "elect_vote":
      return el("li", "ev ev-vote", `警长投票：${ev.voter} 号 → ${ev.target == null ? "弃票" : `${ev.target} 号`}`);
    case "sheriff":
      return logSheriffItem(ev);
    case "digest":
      return el("li", "ev ev-sys", `【第 ${ev.day} 天摘要】${ev.text}`);
    default:
      return el("li", "ev ev-sys", "");
  }
}

/** t:'sheriff' 事件行（附录 t-schema 最终版：elected / none / no-voters / tie-pk / transfer / destroy）。 */
function logSheriffItem(ev) {
  switch (ev.kind) {
    case "elected":
      return el("li", "ev ev-sys", `警长竞选结果：${ev.seat} 号当选警长。`);
    case "no-voters":
      return el("li", "ev ev-sys", "警长竞选结果：全员上警，无投票人，本局无警长。");
    case "none":
      return el("li", "ev ev-sys", "警长竞选结果：本局无警长。");
    case "tie-pk":
      return el("li", "ev ev-sys", `警长竞选平票：${(ev.pk || []).map((s) => `${s} 号`).join("、")} 进入 PK。`);
    case "transfer":
      return el("li", "ev ev-sys", `警徽移交：${ev.from} 号 → ${ev.to} 号接任警长。`);
    case "destroy":
      return el("li", "ev ev-sys", `${ev.from} 号撕毁警徽，本局无警长。`);
    default:
      return el("li", "ev ev-sys", "");
  }
}

function renderSeats(snap) {
  enterTagScope(snap.solo ? "solo" : String(snap.code || ""));
  const grid = $("game-seats");
  /* 标签编辑器展开期间冻结座位网格：快照 1.5s 一轮全量重建会把输入中（尤其移动端
   * 软键盘组词）的自定义标签草稿连同 input 节点一起销毁——草稿永空 →「标签不能为空」
   * 误报（2026-10-05 试玩反馈）。冻结期间 chip / 添加就地刷新；关闭、换座位、换局
   * （enterTagScope 清 openTagSeat）时恢复全量重建。代价：冻结期座位徽章不随快照更新。 */
  if (openTagSeat != null && openTagSeat === renderedTagSeat && grid.firstChild) return;
  grid.textContent = "";
  for (const p of snap.players) {
    if (!p) continue;
    const li = el("li", "seat");
    if (!p.alive) li.classList.add("seat-dead");
    if (p.seat === snap.mySeat) li.classList.add("seat-me");
    li.append(el("span", "seat-no", `${p.seat}`), el("span", "seat-nick", p.nick));
    const badges = el("span", "seat-badges");
    for (const t of seatTags(p.seat)) badges.append(badge("badge-tag", null, t)); // 私人标签置前
    if (p.role && ROLE_NAME[p.role]) badges.append(badge("badge-role", ROLE_ICON[p.role], ROLE_NAME[p.role]));
    /* §2.5（ADR-0014）警长徽章（全程公开）与竞选候选徽章（仅竞选期间快照带 election）；
       判空容错旧局快照（无 sheriff / election 字段） */
    if (snap.sheriff && p.seat === snap.sheriff.seat) badges.append(badge("badge-owner", "crown", "警长"));
    if (snap.election && Array.isArray(snap.election.candidates) && snap.election.candidates.includes(p.seat)) {
      badges.append(badge("badge-ok", null, "候选"));
    }
    if (p.isAI) badges.append(badge("badge-muted", "robot", "AI"));
    if (p.hosted) badges.append(badge("badge-warn", "robot", "托管"));
    if (p.seat === snap.mySeat) badges.append(badge("badge-me", null, "我"));
    if (!p.alive) badges.append(badge("badge-muted", "skull", "出局"));
    li.append(badges);
    /* 私人标签编辑：点「＋」展开内联编辑器（模块状态保住展开态，1.5s 重渲染不收起） */
    const tagBtn = el("button", "btn btn-tag", "+");
    tagBtn.type = "button";
    tagBtn.setAttribute("aria-label", `${p.seat} 号私人标签`);
    tagBtn.setAttribute("aria-expanded", String(p.seat === openTagSeat));
    tagBtn.addEventListener("click", () => {
      openTagSeat = openTagSeat === p.seat ? null : p.seat;
      renderSeats(snap);
    });
    li.append(tagBtn);
    if (p.seat === openTagSeat) {
      li.classList.add("seat-tags-open");
      const editor = el("div", "tag-editor");
      const chips = el("div", "tag-chip-row");
      /* chip 行就地刷新（编辑器冻结期不整格重建——重建会销毁 input 草稿与焦点） */
      const refreshChips = () => {
        chips.textContent = "";
        const current = seatTags(p.seat);
        for (const t of [...TAG_PRESETS, ...current.filter((c) => !TAG_PRESETS.includes(c))]) {
          const chip = el("button", "tag-chip" + (current.includes(t) ? " is-on" : ""), t);
          chip.type = "button";
          chip.setAttribute("aria-pressed", String(current.includes(t)));
          chip.addEventListener("click", () => {
            if (!toggleSeatTag(p.seat, t)) return toast(`最多 ${TAG_MAX} 个标签`);
            refreshChips();
            refreshTagBadges(badges, p.seat);
          });
          chips.append(chip);
        }
      };
      refreshChips();
      const row = el("div", "tag-add-row");
      const input = el("input", "tag-add-input");
      input.maxLength = TAG_LEN_MAX;
      input.placeholder = `自定义标签（≤${TAG_LEN_MAX} 字）`;
      const add = el("button", "btn", "添加");
      add.type = "button";
      const doAdd = () => {
        const err = addSeatTag(p.seat, input.value);
        if (err) return toast(err);
        input.value = "";
        refreshChips(); // 新自定义标签进 chip 行
        refreshTagBadges(badges, p.seat);
        input.focus();
      };
      add.addEventListener("click", doAdd);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
      });
      row.append(input, add);
      editor.append(chips, row);
      li.append(editor);
    }
    grid.append(li);
  }
  renderedTagSeat = openTagSeat;
}

/* ---------- 玩家标签（私人笔记：座位行内快速标注，只存本机 localStorage） ----------
 * 生命周期 = 所属对局：联机按房号一把 key（旧房 key 不清理，单个几十字节，
 * ponytail: 量大时可加启动清理只留最近 N 把）；单机恒 "solo" 一把，开局重置。
 * 纯前端笔记，不进快照、不上传、不影响任何判定。 */

const TAGS_KEY_PREFIX = "ww_tags_";
const TAG_PRESETS = ["好人", "狼", "预言家", "女巫", "猎人", "查杀", "金水"];
const TAG_MAX = 6; // 每座位标签数上限（座位行宽度有限）
const TAG_LEN_MAX = 8; // 单标签字数上限

let tagScope = null;
let tagSeats = {}; // { [seat]: string[] }
let openTagSeat = null; // 当前展开编辑器的座位（模块状态保展开态）
let renderedTagSeat = null; // 当前 DOM 里编辑器所属座位；与 openTagSeat 一致时座位网格跳过重建（保输入草稿与焦点）

function tagsKey(scope) {
  return TAGS_KEY_PREFIX + scope;
}

function readTagsStorage(scope) {
  try {
    if (typeof localStorage === "undefined") return null;
    const d = JSON.parse(localStorage.getItem(tagsKey(scope)) || "null");
    return d && d.seats && typeof d.seats === "object" ? d.seats : null;
  } catch (e) {
    return null; // 坏数据当无标签
  }
}

/** 渲染入口：对局变了（房号 / 单机）就换 scope 重载；同一局刷新恢复原标签。 */
export function enterTagScope(scope) {
  if (scope === tagScope) return;
  tagScope = scope;
  openTagSeat = null;
  renderedTagSeat = null;
  tagSeats = scope ? readTagsStorage(scope) || {} : {};
}

/** 开新局清零（app.js startSolo 调用；联机换房号由 enterTagScope 自然切换）。 */
export function resetTags(scope) {
  tagScope = scope;
  openTagSeat = null;
  renderedTagSeat = null;
  tagSeats = {};
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(tagsKey(scope));
  } catch (e) { /* 存不下就丢（隐私模式） */ }
}

export function seatTags(seat) {
  return (tagSeats[seat] || []).slice();
}

/** 座位徽章行的标签段就地刷新（编辑器冻结期用）：只动 .badge-tag，身份 / AI / 出局等徽章不变。 */
function refreshTagBadges(badges, seat) {
  for (const x of badges.querySelectorAll(".badge-tag")) x.remove();
  const anchor = badges.firstChild;
  for (const t of seatTags(seat)) badges.insertBefore(badge("badge-tag", null, t), anchor);
}

function persistTags() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(tagsKey(tagScope), JSON.stringify({ seats: tagSeats }));
    }
  } catch (e) { /* 存不下就丢（隐私模式），当局内存里仍在 */ }
}

/** 点预置 / 已有标签 = 开关切换。满员返回 false 由调用方 toast。 */
export function toggleSeatTag(seat, tag) {
  const list = tagSeats[seat] || [];
  const i = list.indexOf(tag);
  if (i >= 0) list.splice(i, 1);
  else {
    if (list.length >= TAG_MAX) return false;
    list.push(tag);
  }
  tagSeats[seat] = list;
  persistTags();
  return true;
}

/** 自定义标签：校验 → 入列。返回错误文案或 null。 */
export function addSeatTag(seat, raw) {
  const tag = String(raw || "").trim();
  if (!tag) return "标签不能为空";
  if (tag.length > TAG_LEN_MAX) return `标签最多 ${TAG_LEN_MAX} 字`;
  const list = tagSeats[seat] || [];
  if (list.includes(tag)) return "已有该标签";
  if (list.length >= TAG_MAX) return `最多 ${TAG_MAX} 个标签`;
  list.push(tag);
  tagSeats[seat] = list;
  persistTags();
  return null;
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
    if (snap.serverDrive) {
      /* §4.2（ADR-0016）waitingOwner 更名 serverDrive：服务端闹钟已接管 AI（判空安全，
         部署窗口期旧快照无此字段 = 不显示而已） */
      panel.append(el("p", "hint", "房主暂时掉线，AI 已由服务端自动接管。"));
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
      panel.append(el("p", "action-title", `${title}（不超过 250 字）`)); // 与 shared/game.js SPEECH_MAX 同口径
      const ta = el("textarea", "speech-input");
      ta.maxLength = 250;
      ta.rows = 4;
      ta.placeholder = "说点什么…";
      const counter = el("p", "hint counter", "0 / 250");
      ta.addEventListener("input", () => {
        counter.textContent = `${ta.value.length} / 250`;
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
      if (snap.sheriff && snap.sheriff.seat != null) panel.append(el("p", "hint", "警长一票算 1.5 票。")); // §2.4
      targetPicker(panel, snap, alive.filter((s) => s !== meSeat), (s) => `投票给 ${seatLabel(snap, s)}`, actions.vote);
      confirmButton(panel, "弃票", "本轮弃票", () => actions.vote(null));
      break;
    }
    case "pk_vote": {
      const seats = snap.pkCandidates || [];
      panel.append(el("p", "action-title", `PK 投票：只能投 ${seats.join("、")} 号，或弃票`));
      if (snap.sheriff && snap.sheriff.seat != null) panel.append(el("p", "hint", "警长一票算 1.5 票。")); // §2.4
      targetPicker(panel, snap, seats, (s) => `PK 投票给 ${seatLabel(snap, s)}`, actions.vote);
      confirmButton(panel, "弃票", "本轮弃票", () => actions.vote(null));
      break;
    }
    case "wolf": {
      panel.append(el("p", "action-title", "狼队密聊（只有狼人可见）· 投票定刀"));
      /* §4.1.1 密聊全程日志：狼座私有快照字段，轮询实时刷新；跨夜保留，按夜分组 */
      const chatLog = you && Array.isArray(you.wolfChatLog) ? you.wolfChatLog : [];
      const chatBox = el("ul", "wolf-chat");
      fillWolfChat(chatBox, chatLog, snap.day, meSeat);
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
    /* ---------- §1.3 守卫（ADR-0013）与 §2.3 警长竞选 / 警徽流（ADR-0014） ---------- */
    case "guard": {
      /* 座位选择含自己、不可空守（无跳过按钮）；上晚守护对象禁选（连守限制） */
      panel.append(el("p", "action-title", "守卫守护：选择今晚要守护的人（可守自己，不可空守）"));
      const marks = {};
      if (you && you.guardLast != null) {
        marks[you.guardLast] = { text: "上晚已守", disabled: true };
        panel.append(el("p", "hint", `上晚守护了 ${seatLabel(snap, you.guardLast)}，今晚不可再守同一人。`));
      }
      targetPicker(panel, snap, alive, (s) => `守护 ${seatLabel(snap, s)}`, actions.guardProtect, marks);
      break;
    }
    case "elect_join": {
      panel.append(el("p", "action-title", "警长竞选：是否上警参选？（上警者不参与警长投票）"));
      confirmButton(panel, "上警", "上警参选警长", () => actions.electRun(true), "btn-primary");
      confirmButton(panel, "不上警", "不上警（保留警长投票权）", () => actions.electRun(false));
      break;
    }
    case "elect_withdraw": {
      panel.append(el("p", "action-title", "退水表态：退水将退出竞选（退水后可投票）"));
      confirmButton(panel, "留在台上", "留在台上继续竞选", () => actions.electWithdraw(false), "btn-primary");
      confirmButton(panel, "退水", "退水，退出警长竞选", () => actions.electWithdraw(true));
      break;
    }
    case "elect_campaign":
    case "elect_pk_speak": {
      /* 竞选 / PK 自辩发言：复用发言输入组；按任务要求两步确认（确认条） */
      const title = kind === "elect_campaign" ? "竞选发言：向台下玩家拉票" : "竞选 PK 发言：平票自辩，再争取一轮";
      panel.append(el("p", "action-title", `${title}（不超过 250 字）`));
      const ta = el("textarea", "speech-input");
      ta.maxLength = 250;
      ta.rows = 4;
      ta.placeholder = "说点什么…";
      const counter = el("p", "hint counter", "0 / 250");
      ta.addEventListener("input", () => {
        counter.textContent = `${ta.value.length} / 250`;
      });
      const send = el("button", "btn btn-primary", "提交发言");
      send.type = "button";
      send.addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) {
          toast("发言不能为空");
          return;
        }
        showConfirm("提交竞选发言 —— 确认后不可更改", () => actions.electSpeak(text));
      });
      panel.append(ta, counter, send);
      break;
    }
    case "elect_vote": {
      /* 主轮与 PK 轮同 kind：PK 轮只列 PK 台名单（snap.subPhase 区分轮次） */
      const pkRound = snap.subPhase === "elect_pk_vote";
      const eln = snap.election || {};
      let seats = pkRound ? eln.pkCandidates || [] : eln.candidates || [];
      if (!seats.length) seats = eln.candidates || eln.pkCandidates || []; // 都空时回退「台上候选人」
      panel.append(el("p", "action-title", pkRound
        ? `警长 PK 投票：只能投 ${seats.join("、")} 号，或弃票`
        : "警长投票：选出你心中的警长（或弃票）"));
      if (!seats.length) {
        panel.append(el("p", "hint", "台上暂无候选人。"));
        break;
      }
      targetPicker(panel, snap, seats, (s) => `投警长票给 ${seatLabel(snap, s)}`, actions.electVote);
      confirmButton(panel, "弃票", "本轮警长投票弃票", () => actions.electVote(null));
      break;
    }
    case "badge": {
      /* 警徽处置（死亡警长本人）：移交存活座位或撕毁；两步确认 */
      panel.append(el("p", "action-title", "你是出局的警长：把警徽移交给一名存活玩家，或撕毁警徽"));
      targetPicker(panel, snap, alive, (s) => `把警徽移交给 ${seatLabel(snap, s)}`, actions.badgeMove);
      confirmButton(panel, "撕毁警徽", "撕毁警徽（本局无警长）", () => actions.badgeMove(null));
      break;
    }
    default:
      panel.append(el("p", "hint", "等待中…"));
  }
}

/** 对局整屏渲染。actions 见 app.js（单机本地提交 / 联机 act 提交共用此形状）。 */
/** 狼队密聊列表填充（§4.1.1 修订：跨夜保留，按夜分组；tonightN = 当夜号，传 null = 白天纯历史回看）。 */
function fillWolfChat(box, log, tonightN, meSeat) {
  box.textContent = "";
  let lastN = null;
  for (const m of log) {
    if (m.n !== lastN) {
      lastN = m.n;
      box.append(el("li", "wolf-chat-night", m.n === tonightN ? `第 ${m.n} 夜（今晚）` : `第 ${m.n} 夜`));
    }
    box.append(el("li", "wolf-chat-line" + (m.seat === meSeat ? " me" : ""), `${m.seat} 号：${m.text}`));
  }
  if (tonightN != null && lastN !== tonightN) {
    box.append(el("li", "wolf-chat-night", `第 ${tonightN} 夜（今晚）`));
    box.append(el("li", "wolf-chat-line wolf-chat-empty", "今晚队友还没说话，开个头？"));
  } else if (log.length === 0) {
    box.append(el("li", "wolf-chat-line wolf-chat-empty", "还没有任何密聊记录。"));
  }
}

/** 白天（及非狼行动夜）的狼队密聊历史卡：只读回看（§4.1.1 修订）；狼夜行动面板带实时密聊时不重复。
 * 注意夜里快照不露 subPhase（§4.1.6），判重只能看 action.kind。 */
function renderWolfHistory(snap) {
  const card = $("wolf-history");
  const you = snap.you;
  const log = you && Array.isArray(you.wolfChatLog) ? you.wolfChatLog : [];
  const isWolfAlive = !!(you && isWolf(you.role) && you.alive); // §1.2（ADR-0013）狼王同看密聊历史卡
  const wolfNightPanel = !!(snap.action && snap.action.kind === "wolf");
  const show = isWolfAlive && log.length > 0 && !wolfNightPanel && snap.phase !== "lobby" && snap.phase !== "revealed";
  card.classList.toggle("hidden", !show);
  if (show) fillWolfChat($("wolf-history-list"), log, null, snap.mySeat);
}

/* ---------- 投票记录卡（§5.14）：按天 / 轮次分组的票型速查 ----------
 * 数据 = 公开事件流里既有的 vote / tie / exile 事件（§8.1 公开历史，快照全量自带，
 * 凡能看事件流的人含死者都能看本卡，不加存活限制——过滤无 secrecy 收益）；纯前端
 * 重组：不改内核、不落新数据、ai-prompts §1.3 事件 schema 不动，进行中老对局立即可用。
 * 重组口径：toHistory 落库丢了 main/pk 轮次与票数榜——同一天内 tie 事件即主投票与
 * PK 投票的分界（vote_result 进 PK 时 tie 与 exile{null} 成对发出，先到的 tie 认领
 * 该轮结果，成对的 exile{null} 忽略）；票数从逐人 vote 重算，与内核 tally 同序
 * （票多在前、同票座位号小在前）。 */

/** 公开事件流 → [{ day, kind, votes: [{voter,target}], tally: [{seat,count}], outcome, sheriff }]；
 *  kind = "main"|"pk"（放逐投票）/ "elect"|"elect_pk"（警长竞选，§2.5 ADR-0014）；
 *  outcome = null（进行中）/ {type:"pk",seats} / {type:"exile",seat} / {type:"peaceful"}
 *    / 竞选轮专有 {type:"elected",seat} / {type:"none"}；
 *  sheriff = 该轮放逐投票时的在任警长座位（由日志 sheriff 事件推导，其票计 1.5 权重，§2.4；
 *    竞选轮恒 null——警长尚未产生）。 */
export function voteHistory(events) {
  const rounds = [];
  let cur = null; // 放逐投票当前轮
  let curElect = null; // 警长竞选当前轮
  let sheriffSeat = null; // 现任警长（elected/transfer/destroy 推导）
  for (const ev of events || []) {
    if (ev.t === "sheriff") {
      /* 警长座位推导（1.5 票权重依据）；同时给竞选轮收尾：
         tie-pk 是竞选主轮与 PK 轮的分界；elected / none / no-voters 结清竞选 */
      if (ev.kind === "elected") sheriffSeat = ev.seat;
      else if (ev.kind === "transfer") sheriffSeat = ev.to;
      else if (ev.kind === "destroy" || ev.kind === "none" || ev.kind === "no-voters") sheriffSeat = null;
      if (curElect && !curElect.outcome) {
        if (ev.kind === "tie-pk") curElect.outcome = { type: "pk", seats: ev.pk };
        else if (ev.kind === "elected") curElect.outcome = { type: "elected", seat: ev.seat };
        else if (ev.kind === "none" || ev.kind === "no-voters") curElect.outcome = { type: "none" };
      }
      continue;
    }
    if (ev.t === "elect_vote") {
      /* 竞选轮：按天分组；同日已有收尾轮（tie-pk 后）→ 开 PK 轮（与主投票 tie 分轮界同口径） */
      if (!curElect || curElect.day !== ev.day || curElect.outcome) {
        curElect = {
          day: ev.day,
          kind: curElect && curElect.day === ev.day ? "elect_pk" : "elect",
          votes: [],
          outcome: null,
          sheriff: null,
        };
        rounds.push(curElect);
      }
      curElect.votes.push({ voter: ev.voter, target: ev.target == null ? null : ev.target });
      continue;
    }
    if (ev.t === "vote") {
      if (!cur || cur.day !== ev.day || cur.outcome) {
        cur = { day: ev.day, kind: cur && cur.day === ev.day ? "pk" : "main", votes: [], outcome: null, sheriff: sheriffSeat };
        rounds.push(cur);
      }
      cur.votes.push({ voter: ev.voter, target: ev.target == null ? null : ev.target });
    } else if (ev.t === "tie" || ev.t === "exile") {
      if (!cur || cur.day !== ev.day || cur.outcome) continue;
      cur.outcome = ev.t === "tie"
        ? { type: "pk", seats: ev.seats }
        : ev.seat == null ? { type: "peaceful" } : { type: "exile", seat: ev.seat };
    }
  }
  for (const r of rounds) {
    const cnt = new Map();
    for (const v of r.votes) {
      if (v.target == null) continue;
      /* §2.4 警长一票计 1.5（仅放逐主投票 / PK 投票；竞选轮 sheriff 恒 null 不加权） */
      const w = r.sheriff != null && v.voter === r.sheriff ? 1.5 : 1;
      cnt.set(v.target, (cnt.get(v.target) || 0) + w);
    }
    r.tally = [...cnt.entries()]
      .map(([seat, count]) => ({ seat, count }))
      .sort((a, b) => b.count - a.count || a.seat - b.seat);
  }
  return rounds;
}

/* 轮次名（§2.5：竞选轮名「警长竞选」）与得票数字格式（1.5 票保留一位小数） */
const VOTE_ROUND_NAME = { main: "主投票", pk: "PK 投票", elect: "警长竞选", elect_pk: "警长竞选 PK" };
const fmtVoteCount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** 单轮投票记录 DOM（对局投票记录卡与复盘详情共用）。 */
function voteRoundEl(r) {
  const div = el("div", "vote-round");
  const head = el("div", "vote-round-head", `第 ${r.day} 天 · ${VOTE_ROUND_NAME[r.kind] || "投票"}`);
  if (!r.outcome) head.append(el("span", "vote-ongoing", "（进行中）"));
  div.append(head);
  const ul = el("ul", "vote-votes");
  for (const v of r.votes) {
    const who = r.sheriff != null && v.voter === r.sheriff ? `${v.voter} 号（警长，计 1.5 票）` : `${v.voter} 号`;
    ul.append(el("li", null, `${who} → ${v.target == null ? "弃票" : `${v.target} 号`}`));
  }
  div.append(ul);
  if (r.tally.length) {
    div.append(el("div", "vote-round-meta", "得票：" + r.tally.map((t) => `${t.seat} 号 ${fmtVoteCount(t.count)} 票`).join("、")));
  } else if (r.outcome) {
    div.append(el("div", "vote-round-meta", "得票：无（全员弃票）")); // 已结算且零得票 = 全弃
  }
  if (r.outcome) {
    const text = r.outcome.type === "pk"
      ? `结果：平票，${r.outcome.seats.map((s) => `${s} 号`).join("、")} 进入 PK`
      : r.outcome.type === "exile" ? `结果：放逐 ${r.outcome.seat} 号`
      : r.outcome.type === "elected" ? `结果：${r.outcome.seat} 号当选警长`
      : r.outcome.type === "none" ? "结果：本局无警长"
      : "结果：无人出局（平安日）";
    div.append(el("div", "vote-round-meta", text));
  }
  return div;
}

/** 投票轮次列表填充（对局卡 / 复盘详情共用）。 */
function fillVoteRounds(box, rounds) {
  box.textContent = "";
  for (const r of rounds) box.append(voteRoundEl(r));
}

function renderVoteHistory(snap) {
  const card = $("vote-history");
  const rounds = voteHistory(snap.events);
  const show = rounds.length > 0 && snap.phase !== "lobby" && snap.phase !== "revealed";
  card.classList.toggle("hidden", !show);
  if (!show) return;
  fillVoteRounds($("vote-history-list"), rounds);
}

export function renderGame(snap, actions) {
  renderPhaseBanner(snap);
  renderIdCard(snap);
  renderLog(snap);
  renderWolfHistory(snap);
  renderVoteHistory(snap);
  renderSeats(snap);
  renderAction(snap, actions);
}

/* ---------- 终局复盘（revealed：唯一全员亮牌时机，§5.5） ---------- */

export function renderRevealed(snap) {
  $("result-title").textContent =
    snap.winner === "good" ? "好人胜利" : snap.winner === "wolf" ? "狼人胜利" : "终局";
  const list = $("reveal-list");
  list.textContent = "";
  /* §1.1（ADR-0013）板子名随终局复盘展示；旧局快照无 board 字段时按标准板兜底 */
  const board = snap.board && BOARDS[snap.board] ? BOARDS[snap.board] : BOARDS.standard;
  list.append(el("li", "reveal-item reveal-board", `板子：${board.name}`));
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

/* ---------- 板子选择卡（§1.1，ADR-0013）：单机屏与联机大厅房主同款 ----------
 * 卡片 = 标题 + BOARDS 的 intro 介绍文案（注册表直读，不复制文案）；默认 standard。 */
export function renderBoardPicker(box, selectedId, onPick) {
  box.textContent = "";
  for (const [id, b] of Object.entries(BOARDS)) {
    const btn = el("button", "board-card" + (id === selectedId ? " is-selected" : ""));
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(id === selectedId));
    btn.append(el("span", "board-name", b.name), el("span", "board-intro", b.intro));
    btn.addEventListener("click", () => onPick(id));
    box.append(btn);
  }
}

/* ---------- 战绩与复盘（§3.3，ADR-0015）：本地存档只读回放 ----------
 * 顶部战绩汇总表（aggregateStats，可折叠 <details>）+ 对局列表（日期 / 板子名 /
 * 模式 / 天数 / 胜方）→ 点开复盘详情（只读）：全员身份网格（role + death + won
 * 标记）+ groupLogEvents 按天折叠完整日志 + voteHistory 投票记录（含竞选轮）。
 * 列表 / 详情导航状态在本模块（archiveCache），返回列表不重读存储。 */

let archiveCache = []; // 当前列表数据源（renderArchive 写入，详情返回列表复用）
let archiveMyNick = "";

export function renderArchive(records, myNick) {
  archiveCache = Array.isArray(records) ? records : [];
  archiveMyNick = myNick || "";
  $("archive-detail").hidden = true;
  $("archive-list-wrap").hidden = false;
  const back = $("archive-back");
  if (back) back.onclick = null;
  fillArchiveStats($("archive-stats-body"));
  const box = $("archive-list");
  box.textContent = "";
  if (!archiveCache.length) {
    box.append(el("p", "hint", "还没有存档对局。打完一局（单机或联机）会自动入档，最多保留 30 局。"));
    return;
  }
  for (const rec of archiveCache) {
    const btn = el("button", "archive-item");
    btn.type = "button";
    const d = new Date(rec.ts || 0);
    const when = `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const winner = rec.winner === "wolf" ? "狼人胜" : rec.winner === "good" ? "好人胜" : "未终局";
    btn.append(
      el("span", "archive-item-main", `${rec.board && rec.board.name ? rec.board.name : "标准板"} · ${rec.mode === "online" ? "联机" : "单机"} · ${winner}`),
      el("span", "archive-item-sub", `${when} · 第 ${rec.day} 天结束`),
    );
    btn.addEventListener("click", () => renderArchiveDetail(rec));
    box.append(btn);
  }
}

/** 战绩汇总表：昵称 / 局数 / 胜率 / 常用角色（前二）；「我」按当前昵称弱匹配高亮（§3.3 口径）。 */
function fillArchiveStats(box) {
  box.textContent = "";
  const stats = aggregateStats(archiveCache);
  if (!stats.length) {
    box.append(el("p", "hint", "暂无战绩（只统计存档里的真人座位，AI 不计）。"));
    return;
  }
  const table = el("table", "stats-table");
  const head = el("tr");
  for (const h of ["昵称", "局数", "胜率", "常用角色"]) head.append(el("th", null, h));
  table.append(head);
  for (const s of stats) {
    const tr = el("tr", s.nick === archiveMyNick ? "stats-me" : null);
    const roles = Object.entries(s.roles)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([r]) => ROLE_NAME[r] || r)
      .join(" / ");
    tr.append(
      el("td", null, s.nick),
      el("td", null, String(s.games)),
      el("td", null, `${Math.round(s.rate * 100)}%`),
      el("td", null, roles || "—"),
    );
    table.append(tr);
  }
  box.append(table);
}

/** 复盘详情（只读）：身份网格（won 标记）+ 投票记录卡 + 按天折叠完整公开日志。 */
function renderArchiveDetail(rec) {
  $("archive-list-wrap").hidden = true;
  const det = $("archive-detail");
  det.hidden = false;
  $("archive-back").onclick = () => renderArchive(archiveCache, archiveMyNick);
  const body = $("archive-detail-body");
  body.textContent = "";
  const winner = rec.winner === "wolf" ? "狼人胜利" : rec.winner === "good" ? "好人胜利" : "未终局";
  body.append(el("h3", null, `${rec.board && rec.board.name ? rec.board.name : "标准板"} · ${rec.mode === "online" ? "联机" : "单机"} · ${winner}`));
  const d = new Date(rec.ts || 0);
  body.append(el("p", "hint", `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 第 ${rec.day} 天结束`));

  /* 全员身份网格（终局已全员亮牌；won = 本局胜负，§3.1 记录时已按 isWolf 判定） */
  const grid = el("ul", "reveal-list");
  for (const p of rec.players || []) {
    if (!p) continue;
    const li = el("li", "reveal-item");
    li.append(iconEl(ROLE_ICON[p.role] || "villager"));
    const text = p.death
      ? `${p.seat} 号 ${p.nick} · ${ROLE_NAME[p.role] || "?"} · 出局（第 ${p.death.day} 天${DEATH_CAUSE[p.death.cause] || ""}）`
      : `${p.seat} 号 ${p.nick} · ${ROLE_NAME[p.role] || "?"} · 存活`;
    li.append(el("span", null, text));
    if (p.isAI) li.append(badge("badge-muted", "robot", "AI"));
    if (p.won === true) li.append(badge("badge-ok", "check", "胜"));
    else if (p.won === false) li.append(badge("badge-muted", null, "负"));
    grid.append(li);
  }
  body.append(grid);

  /* 投票记录（含警长竞选轮，§2.5 / §3.3；复用对局投票记录卡的轮次渲染） */
  const rounds = voteHistory(rec.log);
  if (rounds.length) {
    const card = el("details", "card");
    card.append(el("summary", null, "投票记录（按轮次）"));
    const vb = el("div");
    fillVoteRounds(vb, rounds);
    card.append(vb);
    body.append(card);
  }

  /* 按天折叠完整公开日志（复用 renderLog 形态；最新一天默认展开，复盘不做开合记忆） */
  const logBox = el("div", "log");
  const groups = groupLogEvents(rec.log);
  const latestDay = groups.length ? groups[groups.length - 1].day : 0;
  const snapLike = { players: rec.players || [] }; // logItem 的 seatLabel 只读 players
  for (const g of groups) {
    const detDay = el("details", "log-day");
    detDay.open = g.day === latestDay;
    detDay.append(el("summary", "log-day-head", `第 ${g.day} 天 · ${g.events.length} 条`));
    const list = el("ul", "log-day-list");
    for (const ev of g.events) list.append(logItem(snapLike, ev));
    detDay.append(list);
    logBox.append(detDay);
  }
  body.append(logBox);
}
