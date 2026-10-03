# 项目结构

2026-10-03 建档（文档收口时补齐；此前 features.md §12 只有开工蓝图）。每次结构变化必须更新本文件（规则见根目录 `CLAUDE.md` §1）。

## 目录树

```
werewolf/
├── index.html              # 唯一页面：主菜单 / 单机开局 / 联机房间 / 大厅 / 对局 / 终局复盘 / AI 设置 七屏
├── style.css               # 全部样式（单列限宽 ~640px、触控热区 ≥44px、弹窗禁 from-opacity）
├── sw.js                   # Service Worker（shell network-first 带 no-cache 重验，图片字体 cache-first；
│                           #   CACHE=werewolf-vNN，改任何 js/css 必须 +1）
├── manifest.webmanifest    # PWA 清单
├── package.json            # 仅 "type":"module" + scripts.test（零运行时依赖）
├── CLAUDE.md               # 代理工作规则（每次改动必读必守）
├── CONTEXT.md              # 领域词汇表（唯一口径）
├── README.md               # 面向使用者：玩法 / AI 设置 / 架构 / 部署 / 已知限制
├── js/                     # 前端模块（node --test 可直接 import，顶层不碰 DOM）
│   ├── prompts.js          # 薄转发：re-export shared/prompts.js（保留 index.html 模块序与旧导入路径）
│   ├── net.js              # 联机唯一网络层：1.5s rev 轮询 + 退避 + 回前台追赶、uid/会话、act/driveAI
│   ├── ai.js               # BYO 配置（localStorage）、/api/ai-proxy 请求、§5.1 宽容解析、
│   │                       #   toHistory / windowHistory / roleCardOf / phaseOf（单机路径数据件）
│   ├── icons.js            # 全站 SVG 图标库（零 emoji，唯一可用 innerHTML 处）
│   ├── ui.js               # 快照渲染（大厅 / 对局 / 终局）：身份卡、事件流、行动面板、
│   │                       #   两步确认条、toast、顶栏收拢；玩家输入一律 textContent
│   └── app.js              # 入口：切屏状态机 + 单机本地引擎（soloDrive / ww_solo 存取）
│                           #   + 联机接线 + 房主 drive_ai 驱动（快照触发 + 4s 兜底节拍）
├── shared/                 # 浏览器与 Worker 共用的单份内核（ADR-0001）
│   ├── game.js             # 玩法内核纯函数：advance（join/ready/start/夜行动/发言/投票）、
│   │                       #   applyFallback（确定性回退）、pendingSeat、wolfCaptain、checkWinner、
│   │                       #   generateAISeats、witchSeesBlade；零 I/O 零时钟零随机（种子进 state）
│   ├── prompts.js          # 角色提示词 + buildMessages(history, roleCard, phase)：
│   │                       #   恒两条消息、私有字段按角色白名单渲染（防泄密的结构层边界）
│   └── roster.js           # AI 开局名册（ADR-0009）：人格 × 网名池 + drawRoster（rand 注入
│                           #   纯函数）；worker 接口 / DO 开局 / 浏览器兜底共用同一份池子
├── worker/                 # Cloudflare Workers 后端（部署边界，无 package.json，仅靠 wrangler.toml）
│   ├── wrangler.toml       # name=werewolf-room、DO 绑定 ROOM、SQLite 迁移、ALLOWED_ORIGINS、observability
│   └── src/
│       ├── index.js        # Worker 入口：路由表 + CORS 白名单 + 6 位房号生成 + 限流接线 + ai-proxy 请求侧
│       ├── room.js         # DO 薄壳（ADR-0001）：动作分发 / storage 单键持久化 / alarm 接线 /
│       │                   #   drive_ai 出站执行；一切玩法判定调 shared/game.js，本文件不写规则
│       ├── room-logic.js   # 房间纯逻辑（node 可测）：快照按座位裁剪、rev 逐座位对比、心跳/托管/
│       │                   #   150s 超时/房主作废（sweep）、ai_view、AI 契约（buildAIRequest /
│       │                   #   parseAIReply / windowHistory / roleCardOf——与 js/ai.js 同款双份，ADR-0004）
│       ├── ai-proxy.js     # /api/ai-proxy 出站件：信封校验、转发头白名单、body ≤64KB、
│       │                   #   proxyFetch（30s 超时、响应 ≤1MB）、同 IP 日 5000 次限流
│       ├── url-guard.js    # SSRF 防护纯函数：checkUrl + safeOutboundUrl（一切服务端出站必过，永不简化）
│       ├── rate-limit.js   # 建房限流（同 IP 每日 100 房）
│       └── do-rpc.js       # DO stub RPC 收口（roomStub / doRpc，不出 Cloudflare 网络边界）
├── test/                   # node --test 自动发现（81 例）
│   ├── smoke.test.mjs      # 测试器基线
│   ├── frontend.test.mjs   # 前端模块加载 / 零 emoji 扫描 / parseReply / windowHistory / 单机整局回退收敛
│   ├── game-core.test.mjs  # shared/game.js 玩法内核（24 例：流程 / 口径 / 回退）
│   ├── prompts.test.mjs    # shared/prompts.js 消息组装（15 例：形状 / 白名单 / 存活推导）
│   ├── worker.test.mjs     # url-guard 全段 / 房间纯逻辑 / ai-proxy / 路由集成（fake DO）
│   └── acceptance.test.mjs # 单机 + 联机完整对局验收：逐请求断言「公开历史 + 本人身份卡」无泄漏
├── tools/
│   ├── check_site.cjs      # 静态骨架自检（index.html 引用 / sw CACHE 格式 / wrangler.toml 必填）
│   └── smoke-fullgame.mjs  # 整局冒烟（DO 桩 + 上游必败桩 → 全程走回退到 revealed）
├── assets/icons/           # icon.svg / maskable.svg（PWA 图标）
└── docs/                   # features.md（功能真相源）/ PROJECT.md（本文件）/ TASKS.md /
                            #   ai-prompts.md（AI 契约真相源）/ reference-situation-puzzle.md（母本蒸馏）/ adr/
```

index.html 模块加载（`<script type="module">` 按依赖序）：`js/prompts → net → ai → icons → ui → app`，末尾内联注册 sw.js；跨模块依赖靠 ESM import（app → ui/net/ai，ai → prompts/net + `../shared/game.js`）。

## 模块职责速查

| 模块 | 职责 |
|---|---|
| `shared/game.js` | 玩法唯一权威：动作校验与状态推进、夜昼状态机、胜负判定、AI 补位、确定性回退；DO 与前端共用同一份 |
| `shared/prompts.js` | AI 消息组装唯一实现：板子规则 / 5 角色提示词 / 9 任务 / 口吻 + `buildMessages` 白名单渲染 |
| `js/app.js` | 屏幕流转与两种模式的接线：单机本地引擎（含 AI 驱动循环与 localStorage 断点续玩）、联机动作提交、房主 drive_ai 触发 |
| `js/net.js` | 与 Worker 的全部 HTTP 通信：轮询（rev / unchanged / 退避 / 追赶）、身份与房间会话、`act / aiView / driveAI` |
| `js/ai.js` | 浏览器侧 AI 数据件：BYO 配置、请求与重试、响应宽容解析、公开事件 → history、历史窗口、单机 roleCard |
| `js/ui.js` | 只读快照渲染与交互辅助：两步确认条、toast、顶栏；不区分单机 / 联机快照来源 |
| `worker/src/index.js` | 入口路由与 CORS：房内动作转 DO、ai-proxy 请求侧校验、建房限流与房号生成 |
| `worker/src/room.js` | DO 实例：分发动作、单键持久化、alarm 排程、drive_ai 出站（url-guard → proxyFetch → 解析 → 回退） |
| `worker/src/room-logic.js` | 房间规则纯逻辑：快照裁剪（安全边界）、按座 rev、托管 / 超时 / 作废 sweep、服务端 AI 契约 |
| `worker/src/ai-proxy.js` | AI 中转出站件：头白名单、64KB / 1MB 上限、30s 超时、日 5000 次限流 |
| `worker/src/url-guard.js` | 出站 URL 校验（SSRF）：`safeOutboundUrl` 是唯一合法出口，校验与 fetch 数据流强绑定 |

## localStorage 键清单

| 键 | 用途 | 读写模块 |
|---|---|---|
| `ww_uid` / `ww_nick` | 匿名固定身份（断线重连依据；昵称可重复、uid 不可） | net.js |
| `ww_room` | 上次房间号会话（「回到房间」按钮） | net.js |
| `ww_solo` | 单机对局状态 + 公开事件账本（刷新恢复） | app.js |
| `ww_ai_base` / `ww_ai_key` / `ww_ai_model` | BYO 配置（Key 只存本机，按请求透传） | ai.js |
| `ww_api_base` | 可选：覆盖 Worker 基址（自定域 / 反代时） | net.js |

## 联机架构速记

Cloudflare Workers + Durable Objects（SQLite 后端），一个房间 = 一个 DO 实例；前端 1.5s HTTP 增量轮询（非 WebSocket）：快照带**按座位视角**的 `rev` 游标，无变化回 `unchanged`，夜里非行动座位视角冻结、天亮全员齐跳（ADR-0002）。DO 内 alarm 负责：150s 行动超时回退、60s 无心跳转托管、35s 在线窗口、30min 房主失联作废。联机 AI 行动由服务端 `drive_ai` 执行（房主触发并瞬态透传 BYO 配置，ADR-0003）。

## 按改动类型的入口指引

- **改玩法规则 / 流程**：口径先对 `docs/features.md`，改 `shared/game.js`，跑 `test/game-core.test.mjs` + `test/acceptance.test.mjs`。DO 不写规则（薄壳），只动内核即可两端生效。
- **改提示词 / 消息组装**：`shared/prompts.js` + `docs/ai-prompts.md` 同步 + `test/prompts.test.mjs`；`js/prompts.js` 只是转发不用动。注意 DO（drive_ai）与前端（单机）共用这份。
- **改界面 / 交互**：`index.html` + `js/ui.js` + `style.css`；缺图标补 `js/icons.js`；移动端硬指标见 `docs/features.md` §1。改完 sw.js CACHE +1。
- **改联机网络 / 快照形状**：`js/net.js` + `worker/src/index.js` + `worker/src/room-logic.js`（snapshotFor / bumpRevs），`test/worker.test.mjs` 有 rev 与 unchanged 用例。快照裁剪与夜里视角冻结是安全边界，永不简化。
- **改 AI 请求侧规则（解析 / 历史窗口 / roleCard）**：`js/ai.js` 与 `worker/src/room-logic.js` 各持一份同款实现（部署边界所致，ADR-0004），**必须双改**并各跑对应测试。
- **改 DO 计时行为（超时 / 托管 / 作废）**：`worker/src/room-logic.js` 的 `sweep` / `nextAlarmAt` + `room.js` 的 alarm 接线；常量集中在 room-logic.js 头部。
- **改安全边界（url-guard / 出站）**：`worker/src/url-guard.js`（改规则必须同步 `test/worker.test.mjs` 全段用例）；出站一律走 `safeOutboundUrl`，禁止绕过。
- **部署配置**：`worker/wrangler.toml`（CORS 白名单改 `[vars] ALLOWED_ORIGINS`）；部署命令见 `README.md` 部署节。
- **新增 / 删除 js/css/资源模块**：同步 `sw.js` 的 SHELL 清单并 CACHE +1（CLAUDE.md §2）。
- **结构变化后**：更新本文件（目录树 + 职责表 + 入口指引）。
