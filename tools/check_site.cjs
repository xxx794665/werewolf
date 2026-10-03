#!/usr/bin/env node
/* ============================================================
 * tools/check_site.cjs —— 零构建静态站自检（CommonJS，node tools/check_site.cjs）
 * ------------------------------------------------------------
 * 检查项（骨架纪律，无外部依赖）：
 *   1. index.html 引用的本地 js / css / manifest / 图标路径都存在
 *   2. sw.js 的 CACHE 版本号格式正确（werewolf-vNN，N 为正整数）
 *   3. worker/wrangler.toml 必填字段齐全（name / main / DO 绑定 / SQLite 迁移 /
 *      ALLOWED_ORIGINS / observability，见 docs/reference-situation-puzzle.md 第三节）
 * 退出码：0 = 全部通过；1 = 有问题（逐条打印后退出）。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const problems = [];

function fail(msg) {
  problems.push(msg);
}

function readIfExists(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    fail("缺少文件：" + rel);
    return null;
  }
  return fs.readFileSync(abs, "utf8");
}

/* ---------- 1. index.html 的本地引用都存在 ---------- */
const html = readIfExists("index.html");
if (html) {
  /* 提取所有 src / href 属性值；跳过锚点、data:、http(s):、协议相对、mailto/tel */
  const refs = [];
  const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const v = m[1].trim();
    if (!v || v.startsWith("#") || v.startsWith("data:")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) continue; /* http: https: mailto: … */
    if (v.startsWith("//")) continue; /* 协议相对 */
    refs.push(v);
  }
  for (const ref of refs) {
    const rel = ref.replace(/^\.\//, "").split(/[?#]/)[0];
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      fail("index.html 引用的本地路径不存在：" + ref);
    }
  }
  if (refs.length === 0) {
    fail("index.html 没有任何本地 js/css 引用（骨架至少应引用 style.css 与 js/app.js）");
  }
}

/* ---------- 2. sw.js 的 CACHE 版本号格式 ---------- */
const sw = readIfExists("sw.js");
if (sw) {
  const m = sw.match(/(?:const|var|let)\s+CACHE\s*=\s*["']([^"']+)["']/);
  if (!m) {
    fail("sw.js 找不到 CACHE 常量声明（应为 const CACHE = \"werewolf-vNN\"）");
  } else if (!/^werewolf-v\d+$/.test(m[1])) {
    fail("sw.js 的 CACHE 版本号格式错误：\"" + m[1] + "\"（应为 werewolf-vNN，N 为正整数）");
  }
}

/* ---------- 3. worker/wrangler.toml 必填字段 ---------- */
const toml = readIfExists(path.join("worker", "wrangler.toml"));
if (toml) {
  const mustLine = [
    [/^name\s*=\s*"werewolf-room"/m, "顶层 name = \"werewolf-room\""],
    [/^main\s*=\s*"src\/index\.js"/m, "main = \"src/index.js\""],
    [/^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/m, "compatibility_date = \"YYYY-MM-DD\""],
    [/^\[\[durable_objects\.bindings\]\]/m, "[[durable_objects.bindings]]"],
    [/^name\s*=\s*"ROOM"/m, "DO 绑定 name = \"ROOM\""],
    [/^class_name\s*=\s*"Room"/m, "DO 绑定 class_name = \"Room\""],
    [/^\[\[migrations\]\]/m, "[[migrations]]"],
    [/^tag\s*=\s*"v1"/m, "migrations tag = \"v1\""],
    [/^new_sqlite_classes\s*=\s*\[\s*"Room"\s*\]/m, "new_sqlite_classes = [\"Room\"]（SQLite 迁移）"],
    [/^ALLOWED_ORIGINS\s*=\s*"[^"]+"/m, "[vars] ALLOWED_ORIGINS"],
    [/^\[observability\]/m, "[observability]"],
    [/^enabled\s*=\s*true/m, "observability enabled = true"]
  ];
  for (const [re, label] of mustLine) {
    if (!re.test(toml)) {
      fail("worker/wrangler.toml 缺必填字段：" + label);
    }
  }
  /* ALLOWED_ORIGINS 必须含 Pages 域与 localhost 开发口（features.md §9） */
  const ao = toml.match(/^ALLOWED_ORIGINS\s*=\s*"([^"]+)"/m);
  if (ao) {
    const origins = ao[1].split(",").map((s) => s.trim());
    if (!origins.includes("https://werewolf.xxx794665.party")) {
      fail("ALLOWED_ORIGINS 缺前端自定义域 https://werewolf.xxx794665.party");
    }
    if (!origins.includes("https://xxx794665.github.io")) {
      fail("ALLOWED_ORIGINS 缺 Pages 域 https://xxx794665.github.io");
    }
    if (!origins.some((o) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(o))) {
      fail("ALLOWED_ORIGINS 缺 localhost 开发口");
    }
  }
  /* main 指向的入口存在 */
  if (/^main\s*=\s*"src\/index\.js"/m.test(toml)) {
    if (!fs.existsSync(path.join(root, "worker", "src", "index.js"))) {
      fail("wrangler.toml 的 main 指向的 worker/src/index.js 不存在");
    }
  }
}

/* ---------- 汇总 ---------- */
if (problems.length) {
  console.error("[check_site] 发现 " + problems.length + " 个问题：");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
} else {
  console.log("[check_site] OK：index.html 引用、sw.js CACHE 版本号、worker/wrangler.toml 必填字段全部通过");
  process.exit(0);
}
