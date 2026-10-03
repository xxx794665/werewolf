# 参考项目蒸馏：situation_puzzle（联机与部署方案母本）

> 供 werewolf 所有开发代理阅读。母本仓库：`D:\git\situation_puzzle`（海龟汤推理游戏，同账号已跑通的同款架构）。本文件 2026-10-02 由主代理实读母本后蒸馏；细节冲突时以母本实际代码口径为准。werewolf 的需求（单机 AI 扮演、联机 AI 补位、AI 代理解决 CORS、移动端优先）在母本里都有直接对应的成熟模式。

## 一、总体架构（照抄）

- 前端：纯静态、零构建、无框架。原生 HTML/CSS/JS 直接推 GitHub Pages，不经过 CI。
- 后端：Cloudflare Workers + Durable Objects（SQLite 后端，免费额度内），**一个房间 = 一个 DO 实例**。
- 通信：**HTTP 短轮询（第一版不用 WebSocket）**，1.2~1.5s 一次；快照带 `rev` 游标，服务端无变化时只回几十字节 `unchanged`；页面回前台先 300ms×4 次追赶轮询再回常规频率；断线重连靠 localStorage 固定身份（uid + 昵称）。母本决策表原文：「HTTP 轮询，跑通再升 WebSocket」。
- 身份：进房顺序显示 `#2/#3…`，内部 `internalId` 加固；昵称可重复；在线窗口 35s、死座位 60s 回收、同名接管 60s。

## 二、文档纪律（用户点名要的「自动更新文档」，原样建一套）

根目录 `CLAUDE.md` 写成代理工作规则，硬性条款：

1. 功能更新完成后必须同步更新文档（顺序不限）：
   - `docs/TASKS.md` 顶部追加任务记录（倒序索引），格式：`日期 ｜ 需求 ｜ 主要改动 ｜ 结果与证据`；
   - `README.md` 受影响段落（玩法、机制、项目结构、已知限制）；
   - 新领域词汇或词义变化 → `CONTEXT.md`；项目结构变化 → `docs/PROJECT.md`；
   - 「难逆转 + 后人会困惑 + 真实取舍」的决策 → `docs/adr/`（编号递增，短段落即可）。
2. 改任何 js/css 后，`sw.js` 的 CACHE 版本号 +1（命名 `werewolf-vNN`）。
3. 提交前自检：跑通 `npm test`（本项目 = `node --test test/`）。

## 三、Worker 侧模式（werewolf 后端照这个写）

- `worker/wrangler.toml`：`name`（本项目用 `werewolf-room`）、`main = "src/index.js"`、`compatibility_date` = 部署当日、`[[durable_objects.bindings]]`（name=ROOM, class_name=Room）+ `[[migrations]]`（tag=v1, new_sqlite_classes=["Room"]）、`[vars] ALLOWED_ORIGINS` 白名单、`[observability] enabled = true`。母本 worker 目录没有 package.json，仅靠 wrangler.toml 即可部署。
- `worker/src/index.js`：路由表——`POST /api/room/new` 建房返回 6 位房号、`POST /api/room/:code/*` 房内动作转发给 DO、`GET /api/room/:code/state` 轮询快照、`GET /api/health` 健康检查。CORS 只放行 ALLOWED_ORIGINS；建房限流（同 isolate 内存 Map、同 IP 每日上限，防公开网址被刷）；房号字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（去易混 I/O/0/1）。
- `worker/src/room.js`：DO = 房间状态机（lobby → playing → revealed），所有动作统一走 DO 的 `fetch(?action=xxx)`。
- **AI 代理 `/api/ai-proxy`——CORS 的解法**：浏览器把 BYO Key 与请求体发给 Worker（Worker 对 Pages 域开 CORS），Worker 服务端出站转发（服务端无 CORS 限制）。转发头白名单（content-type / authorization / x-api-key / anthropic-version / accept），body ≤ 64KB、响应 ≤ 1MB，同 IP 日调用上限。Key 只存浏览器 localStorage、按请求透传，服务端不落盘。
- **url-guard（SSRF 防护，werewolf 的验收条件）**：服务端任何出站 fetch 前必须校验目标 URL——仅 http/https；拒绝 localhost 与 `.local/.internal/.intranet/.lan/.home/.arpa` 主机名；拒绝环回/私网/链路本地/保留 IPv4 段（0/8、10/8、127/8、169.254/16、172.16-31、192.168/16、100.64/10、192.0.x、198.18-19、≥224 组播保留）；拒绝 IPv6 `::`、`::1` 及 fc/fd/fe/ff 前缀；拒绝 URL 内嵌账密。母本实现 `worker/src/url-guard.js`（约 60 行纯函数，返回 null=合法 / 字符串=拒绝原因，直接照抄改注释）。

## 四、前端侧模式

- 轮询客户端（母本 `js/net.js`）：对外 API——`available() / createRoom(nick) / joinRoom(code,nick) / watch(cb) / unwatch() / act(action, body) / me`；`POLL_MS = 1500`；rev 游标增量；localStorage 存固定身份。
- 移动端约定（用户点名移动端优先）：`pointer:coarse` 触控热区 ≥44px；顶栏吸顶 + 滚动收拢；单列布局、大屏正文限宽 ~640px；最小字号 ≥12px；弹窗禁用 from-opacity 入场动画（中间态会「透明拦截」点击）；flex 布局防压瘪。
- 资源：>1MB 的数据移出首屏、空闲预载；PWA（`manifest.webmanifest` + `sw.js`：HTML/CSS/JS network-first、图片字体 cache-first、CACHE 版本号递增）。
- 风格口味：全站零 emoji，图标一律走 SVG 图标库；单 `style.css`；母本走查法——多档视口（360/390/844×390/834/1024/1366）× 各屏，查横向溢出、遮挡、热区。

## 五、本机环境事实（2026-10-02 核实）

- git 远程 `git@github.com:xxx794665/werewolf.git`：SSH 可达，GitHub 仓库已创建但为空、无任何提交；本地在未出生的 `master` 分支，**首次提交前改名 `main`**。Pages 预计地址 `https://xxx794665.github.io/werewolf/`。
- gh CLI 未安装：GitHub Pages 无法用 API 开启。推送后若 Pages 404，把「仓库 Settings → Pages → Branch 选 main → Save」列为用户手动一次性步骤。
- wrangler 已在本机 login（`~/.wrangler/config/default.toml` 存在，与母本同账号）。部署：在 `worker/` 目录 `npx wrangler deploy`，或仓库根 `npx wrangler deploy --config worker/wrangler.toml`（config 内相对路径按 config 文件位置解析）。
- node v22.20.0、npm 10.9.3。`node --test` 是内置测试器（无需 vitest 等框架）。根目录建议 `package.json {"type":"module"}`，让 node 测试直接以 ESM 加载 `shared/`、`worker/src/` 与前端模块（浏览器侧 `<script type="module">` 不受影响）。
- 母本经验：workers.dev 域名部分地区 DNS 污染不可达，母本用自定义域反代解决；werewolf 第一版先用 workers.dev 地址，2026-10-03 已跟进同款方案（后端 `werewolf-room.xxx794665.party`、前端 `werewolf.xxx794665.party`，ADR-0006）。

## 六、ponytail（懒惰高级开发哲学，全部编码代理执行）

动手前先爬梯子：这事必须存在吗（YAGNI）→ 仓库里已有吗 → 标准库/平台原生能做到吗 → 已有依赖能覆盖吗 → 能一行吗 → 最后才写最小可用代码。无单实现接口、无「为以后预留」的脚手架、删优于增、无聊优于聪明。非平凡逻辑（分支、循环、解析、安全路径）必须留下一个最小可运行检查（本项目 = `node --test` 里的用例）。砍掉真实角落的刻意简化标 `ponytail:` 注释（写明天花板与升级路径）。安全边界（SSRF 校验、输入校验）、无障碍基础、用户点名要的东西**永不简化**。
