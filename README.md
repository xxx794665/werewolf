# 狼人杀（单机 AI 扮演 + 联机 AI 补位）

移动端优先的零构建狼人杀网页应用：**单机** = 1 真人 + 8 个 LLM 扮演的 AI 在浏览器本地对局；**联机** = 房间制，真人不足 9 人由 AI 补位。唯一板子 9 人固定：3 狼 + 3 平民 + 预言家 + 女巫 + 猎人。AI 大模型接口由玩家自带（BYO），前端纯静态推 GitHub Pages，房间后端跑 Cloudflare Workers + Durable Objects。

> 功能口径唯一真相源：`docs/features.md`（冻结版）。项目结构与模块职责：`docs/PROJECT.md`。任务流水：`docs/TASKS.md`。

## 玩法

### 单机（1 真人 + 8 AI）

主菜单「单机开局」→ 填昵称 → 两步确认后本地开局：同一份游戏内核（`shared/game.js`）直接在玩家浏览器里跑，不建网络房间，刷新可恢复（进度存 localStorage），无行动超时。8 个 AI 座位轮到时由本机组装提示词并请求你配置的模型接口；AI 请求失败自动走确定性回退（兜底发言 / 随机合法行动），对局不会卡死。

### 联机（房间制 + AI 补位）

建房得 6 位房号（去易混字符 I/O/0/1）→ 朋友凭房号进房 → 各自点「准备」→ 房主开始。开桌最少 3 名真人，空位一律先弹窗确认再由 AI 补足到 9（AI 昵称 `AI-1`…`AI-8`，即公开标识）。联机中 AI 座位与掉线托管座位由房主驱动、服务端执行；任何人挂机 150 秒后由服务端确定性回退推进，房主失联 30 分钟房间作废只读。断线重连靠 localStorage 固定身份（uid + 昵称）。

### 角色（9 人固定板）

| 角色 | 数量 | 技能口径 |
|---|---|---|
| 狼人 | 3 | 每夜由狼队长定刀（不可空刀），狼互相知道队友 |
| 平民 | 3 | 无技能，白天发言与投票 |
| 预言家 | 1 | 每夜验 1 人，得知好人 / 狼人（不可验自己与死者） |
| 女巫 | 1 | 解药、毒药各全局 1 瓶，同晚至多一瓶；仅首夜可自救 |
| 猎人 | 1 | 出局可翻牌开枪带走 1 人；被毒死开不了枪 |

胜负为屠城制：狼全灭则好人胜，狼存活数 ≥ 非狼存活数则狼胜。死亡一律暗牌（猎人翻牌与终局复盘除外）。不可逆操作（定刀 / 用药 / 开枪 / 投票 / 开始）一律两步确认。

### 昼夜流程

- **夜晚**：狼人定刀 → 预言家验人 → 女巫用药（看刀口 / 解药救 / 毒 1 人 / 跳过）→ 天亮结算。夜里非行动座位只看到「第 N 夜」，看不到子阶段与轮到谁（防从快照推断神职存活）；天亮一次性公布全部死者。
- **白天**：公布死者 →（夜死猎人翻牌开枪，如触发）→ 首夜死者遗言 → 按座位顺序轮流发言（每人 ≤200 字）→ 逐人公开投票 → 放逐 + 遗言 →（被放逐猎人开枪，如触发）→ 判胜负。最高票平票则 PK 发言后重投，再平即平安日。

## AI 接口设置（BYO，CORS 已解决）

1. 主菜单「AI 设置」填三项：**接口地址**（OpenAI 兼容前缀，如 `https://api.openai.com/v1`）、**API Key**、**模型名**。三者只存浏览器 localStorage，按请求透传，服务端不落盘；Key 可空（本地网关类上游允许）。
2. 所有 AI 请求经 Worker 的 `/api/ai-proxy` 服务端转发，浏览器不直连上游——**跨域（CORS）由此解决**：Worker 对 Pages 域开 CORS，服务端出站无 CORS 限制。
3. 请求格式统一为 OpenAI 兼容 `POST {baseUrl}/chat/completions`（`temperature 0.7`、`max_tokens 800`）；Anthropic / Gemini 原生格式不在第一版（兼容网关可用即达标）。
4. 转发侧限制：请求体 ≤ 64KB、响应 ≤ 1MB、单次 30s 超时、失败重试 1 次、仍失败走确定性回退；出站目标必过 url-guard（SSRF 防护，拒绝内网 / 保留地址）。

未配置 AI 接口也能开局：AI 座位全部走兜底发言与随机合法行动（开局有提示）。

## 技术架构

```
浏览器（GitHub Pages，纯静态零构建）
  ├─ shared/game.js   游戏内核（板子 / 胜负 / 流程 / 确定性回退），前端与 DO 共用单份 ESM
  ├─ js/*             切屏状态机、轮询客户端、AI 请求与解析、渲染
  │      │  HTTP 短轮询（1.5s；rev 按座位视角游标；无变化回 unchanged；
  │      │  连续 5 次 unchanged 退避 4s；回前台 300ms×4 追赶）
  ▼
Cloudflare Workers（werewolf-room）
  ├─ /api/room/new        建房（6 位房号，同 IP 每日 100 房限流）
  ├─ /api/room/:code/*    房内动作 → 转发 Durable Object
  ├─ /api/room/:code/state 轮询快照（按请求者座位裁剪私有信息）
  ├─ /api/ai-proxy        AI 中转（CORS 解法 + url-guard + 限流 5000 次/IP/日）
  └─ /api/health          健康检查
Durable Objects：一个房间 = 一个 DO 实例（SQLite 后端），
游戏状态机与唯一权威；行动超时 150s（alarm）、托管、房主作废均由 DO 计时执行。
```

要点：一处规则只写一份——玩法判定在 `shared/game.js`，角色提示词在 `shared/prompts.js`，前端与 Worker 共用；快照按座位裁剪、夜里视角冻结是安全边界（详见 `docs/features.md` §2、§4.1.6、§8.1，ADR-0002）。

## 部署

前端（GitHub Pages）与后端（Cloudflare Workers）分开部署。

### 后端：Cloudflare Worker

```bash
cd worker
npx wrangler deploy
```

或仓库根执行 `npx wrangler deploy --config worker/wrangler.toml`。`worker/` 目录不需要 package.json（仅靠 `wrangler.toml`）。本地联调：`cd worker && npx wrangler dev`（默认 `http://localhost:8788`，前端在本机 localhost 打开时自动切到该地址）。

### 前端：GitHub Pages

1. 推送仓库到 `main` 分支（首次提交前若本地分支仍是 `master`，先 `git branch -m main`）。
2. GitHub 仓库 → **Settings → Pages → Branch 选 `main`（根目录）→ Save**。gh CLI 不可用，这一步需在网页上手动操作一次（一次性）。
3. 发布地址：`https://xxx794665.github.io/werewolf/`。

### 部署状态（2026-10-03 部署后核实）

- Worker 已部署：`https://werewolf-room.249939260.workers.dev`（版本 `1e580b68`；首次部署因 compatibility_date 触发 UTC 校验报 10021，已改为 2026-10-02 重部署成功）。健康检查经外部通道实测返回 `{"ok":true}`；本机直连 workers.dev 因 DNS 污染不可达（见已知限制）。
- 仓库已推送：6 个提交至 `origin/main`。
- Pages 待开启：仓库 **Settings → Pages → Branch 选 `main`（根目录）→ Save**（gh CLI 未装，需网页手动一次），生效地址 `https://xxx794665.github.io/werewolf/`。

## 本地开发与自检

```bash
npm test                     # node --test 全量测试（test/ 自动发现，81 例）
node tools/check_site.cjs    # 静态骨架自检（index.html 引用 / sw 版本号 / wrangler.toml）
node tools/smoke-fullgame.mjs # 整局冒烟（建房开桌到终局，上游桩失败走回退）
```

## 已知限制

- **workers.dev 域名 DNS 污染风险**：后端默认地址 `werewolf-room.249939260.workers.dev` 在部分地区可能被 DNS 污染不可达（母本 situation_puzzle 同款经验，本机已实际命中）。第一版先照用，不做自定义域反代（`docs/features.md` 非目标 #12）；受影响的用户可换网络环境，或部署后自配反代并经 `localStorage.ww_api_base` 覆盖接口地址。
- **轮询延迟**：HTTP 短轮询（非 WebSocket），普通节奏 1.5s 一拍，无变化退避至 4s，页面回前台有追赶；狼人杀回合制下体感可接受，但动作送达有秒级延迟（ADR-0001，升级 WebSocket 属后续）。
- **未覆盖真机实测**：截至 2026-10-03 未做真机与多端实测。移动端硬指标（热区 ≥44px、单列限宽、最小字号等）已按 `docs/features.md` §1 落实并写了前端测试，但多档视口 × 全屏走查（360/390/844×390/834/1024/1366）只覆盖桌面浏览器，首次部署后需真机过一遍。
- **限流配额为 isolate 内存计数**：AI 中转同 IP 每日 5000 次、建房同 IP 每日 100 房，Worker 重新部署 / 休眠唤醒后清零；重度玩家一天内配额可能耗尽（单局约 60–100 次 AI 调用）。
- **弱模型可能输出格式漂移**：提示词靠宽容解析 + 确定性回退兜底，模型能力差时 AI 表现明显下降（`docs/ai-prompts.md` §6）。
- **联机互信模型**：不防房主作弊——联机 AI 行动由服务端 `drive_ai` 执行，但触发时机与上游可被房主操纵（`docs/features.md` §13.9）。

## 文档索引

| 文件 | 内容 |
|---|---|
| `docs/features.md` | 功能规格冻结版（唯一功能真相源） |
| `docs/PROJECT.md` | 目录树、模块职责速查、按改动类型的入口指引 |
| `docs/TASKS.md` | 任务流水（倒序） |
| `docs/ai-prompts.md` | AI 提示词与请求契约（数据 schema 真相源） |
| `docs/adr/` | 架构决策记录（编号递增） |
| `CONTEXT.md` | 领域词汇表 |
| `CLAUDE.md` | 代理工作规则（改代码前必读） |
