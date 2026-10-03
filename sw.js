/* ============================================================
 * sw.js —— PWA 离线缓存（骨架，CACHE 从 werewolf-v1 起）
 * ------------------------------------------------------------
 * 策略（母本 2026-09-29 修订教训照抄）：
 *   - HTML / CSS / JS / manifest：network-first，且 fetch 带 { cache: "no-cache" }
 *     条件重验——裸 fetch 会先吃浏览器 HTTP 缓存，GitHub Pages 对所有文件发
 *     max-age=600，10 分钟窗口内拿到的全是旧文件（「网络优先」实际变成
 *     「HTTP 缓存优先」）。离线时回退缓存，绝不白屏。
 *   - 图片 / 字体：cache-first（素材不常变，秒开优先）。
 * 硬规则（CLAUDE.md）：改任何 js/css 后，本文件 CACHE 版本号 +1（werewolf-vNN）；
 *   新增 / 删除模块或资源时同步更新 SHELL 清单并 +1。
 * ============================================================ */

const CACHE = "werewolf-v11";

const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./shared/prompts.js",
  "./shared/roster.js",
  "./shared/game.js",
  "./js/prompts.js",
  "./js/net.js",
  "./js/ai.js",
  "./js/icons.js",
  "./js/ui.js",
  "./js/app.js",
  "./assets/icons/icon.svg",
  "./assets/icons/maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; /* 只管同源静态资源，API 不缓存 */

  const isAsset = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(url.pathname);
  if (isAsset) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

/* 图片 / 字体：先吃缓存秒开，没有再取网络回填 */
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone());
  }
  return res;
}

/* HTML / CSS / JS / manifest：网络优先（no-cache 重验，避开 HTTP 缓存旧版），离线回退缓存 */
async function networkFirst(req) {
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}
