/* ============================================================
 * js/net.js —— 轮询客户端（联机唯一网络层）
 * ------------------------------------------------------------
 * 对外 API（母本 js/net.js 同款形状，docs/reference-situation-puzzle.md 第四节）：
 *   apiBase()                  Worker 基址（ai.js 拼 /api/ai-proxy 也用它）
 *   available()                GET /api/health → boolean
 *   createRoom(nick)           POST /api/room/new → { code, seat }
 *   joinRoom(code, nick)       POST /api/room/:code/join → { seat }
 *   act(action, body)          POST /api/room/:code/:action（自动带 uid）
 *   aiView(seat)               act("ai_view", { seat })（owner 专属，ADR-0002）
 *   driveAI(cfg)               act("drive_ai", { baseUrl, model, key })(owner 专属)
 *   watch(cb) / unwatch()      快照订阅：cb(snapshot) 或 cb({ error })
 *   me()                       { uid, nick }（localStorage 固定身份，features.md §2）
 *   setNick(nick)
 *   saveSession(code) / loadSession() / clearSession()   断线重连依据
 * 轮询口径（features.md §2）：
 *   - POLL_MS = 1500；连续 5 次 unchanged 退避 4000ms；快照一变立即恢复 1500ms
 *   - 页面回前台先 300ms × 4 次追赶轮询再回常规频率
 *   - rev 是按座位视角各自计算的游标：无变化服务端只回 unchanged（几十字节）；
 *     夜里非行动座位视角冻结，天亮全员齐跳（§4.1.6，ADR-0002）
 * 本模块不碰 DOM；node 环境下 localStorage / location 缺席时用内存兜底，
 * 保证 node --test 可直接 import（模块加载自检）。
 * ============================================================ */

export const POLL_MS = 1500;
const BACKOFF_MS = 4000;
const BACKOFF_AFTER = 5; // 连续 unchanged 次数阈值（§2）
const CATCHUP_TIMES = 4;
const CATCHUP_MS = 300;

/* ---------- Worker 基址 ----------
 * 生产走用户在 Cloudflare 配的自定义域（绕开 workers.dev 地区性 DNS 污染，ADR-0006）；
 * 本机开发（localhost 打开页面）默认打本地 wrangler dev。
 * 可用 localStorage.ww_api_base 覆盖；workers.dev 地址仍有效，作备用。 */
const DEFAULT_BASE = "https://werewolf-room.xxx794665.party";

/* localStorage 兜底：node 测试环境没有，用内存 Map 顶替（仅保证可 import） */
const mem = new Map();
const store =
  typeof localStorage !== "undefined"
    ? localStorage
    : {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      };

export function apiBase() {
  const o = store.getItem("ww_api_base");
  if (o) return o.replace(/\/+$/, "");
  if (typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    return "http://localhost:8788"; // wrangler dev 默认口（wrangler.toml [vars] 开发口）
  }
  return DEFAULT_BASE;
}

/* ---------- 身份（localStorage 固定身份，§2 / §7） ---------- */

function newUid() {
  /* uid 是自声明的匿名重连标识（非密钥，features.md §13.8），但随机源没理由降级：
   * 页面本身要求 ESM 与 Service Worker，crypto 必然存在；不存在时直接抛错。 */
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return "u" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("当前环境没有 crypto，无法生成 uid");
}

export function me() {
  let uid = store.getItem("ww_uid");
  if (!uid) {
    uid = newUid();
    store.setItem("ww_uid", uid);
  }
  return { uid, nick: store.getItem("ww_nick") || "" };
}

export function setNick(nick) {
  store.setItem("ww_nick", String(nick || "").trim());
}

/* ---------- 房间会话（断线重连：uid + 房号都在 localStorage） ---------- */

export function saveSession(code) {
  store.setItem("ww_room", JSON.stringify({ code }));
}
export function loadSession() {
  try {
    const s = JSON.parse(store.getItem("ww_room") || "null");
    return s && typeof s.code === "string" ? s : null;
  } catch (e) {
    return null;
  }
}
export function clearSession() {
  store.removeItem("ww_room");
}

/* ---------- 底层请求 ---------- */

async function req(method, path, body) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    const err = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    return { error: typeof err === "string" ? err : String(err), status: res.status };
  }
  return data;
}

export async function available() {
  try {
    const r = await req("GET", "/api/health");
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}

export async function createRoom(nick) {
  const r = await req("POST", "/api/room/new", { nick, uid: me().uid });
  if (r && r.code) saveSession(r.code);
  return r;
}

export async function joinRoom(code, nick) {
  const c = String(code || "").trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(c)) return { error: "房号必须是 6 位代码（字母数字，不含 I/O/0/1）" };
  const r = await req("POST", `/api/room/${c}/join`, { nick, uid: me().uid });
  if (r && r.ok) {
    saveSession(c);
    return { ...r, code: c };
  }
  return r;
}

export function act(action, body) {
  const s = loadSession();
  if (!s) return Promise.resolve({ error: "不在任何房间中" });
  return req("POST", `/api/room/${s.code}/${action}`, { uid: me().uid, ...(body || {}) });
}

export function aiView(seat) {
  return act("ai_view", { seat });
}

export function driveAI(cfg) {
  return act("drive_ai", { baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key || "" });
}

/* ---------- 轮询（rev 游标 + 退避 + 回前台追赶） ---------- */

let watchCode = null;
let watchCb = null;
let rev = null;
let unchanged = 0;
let timer = null;
let polling = false;

function delay() {
  return unchanged >= BACKOFF_AFTER ? BACKOFF_MS : POLL_MS;
}

async function pollOnce() {
  if (!watchCode || !watchCb) return;
  if (polling) return; // 上一次还没回来（慢网），本轮跳过
  polling = true;
  try {
    const q = `?uid=${encodeURIComponent(me().uid)}${rev != null ? `&rev=${rev}` : ""}`;
    const r = await req("GET", `/api/room/${watchCode}/state${q}`);
    if (!watchCb) return; // 等待期间被 unwatch
    if (r && r.error) {
      /* 房间不存在 / 不在房内：会话失效，通知上层后停轮询 */
      if (r.status === 404) {
        const cb = watchCb;
        unwatch();
        clearSession();
        cb({ error: r.error, gone: true });
        return;
      }
      watchCb({ error: r.error });
    } else if (r && r.unchanged) {
      unchanged += 1;
    } else if (r) {
      unchanged = 0;
      rev = r.rev != null ? r.rev : rev;
      watchCb(null, r);
    }
  } catch (e) {
    unchanged += 1; // 网络错误按退避档走，不打爆
    if (watchCb) watchCb({ error: "网络异常，重试中" });
  } finally {
    polling = false;
  }
}

function loop() {
  if (!watchCode) return;
  timer = setTimeout(async () => {
    await pollOnce();
    loop();
  }, delay());
}

/** 回前台：先 300ms × 4 次追赶轮询，再回常规频率（§2，母本同款）。 */
async function catchup() {
  if (!watchCode) return;
  clearTimeout(timer);
  for (let i = 0; i < CATCHUP_TIMES && watchCode; i++) {
    await pollOnce();
    if (i < CATCHUP_TIMES - 1 && watchCode) await new Promise((r) => setTimeout(r, CATCHUP_MS));
  }
  loop();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") catchup();
  });
}

/** 订阅快照。cb(null, snapshot) 正常；cb({ error, gone? }) 异常。 */
export function watch(code, cb) {
  unwatch();
  watchCode = String(code || "").trim().toUpperCase();
  watchCb = cb;
  rev = null;
  unchanged = 0;
  pollOnce().then(loop);
}

export function unwatch() {
  watchCode = null;
  watchCb = null;
  clearTimeout(timer);
  timer = null;
}

/** 当前订阅的房号（app.js 展示用）。 */
export function watchedRoom() {
  return watchCode;
}
