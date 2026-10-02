# CLAUDE.md —— 代理工作规则（硬性）

> 任何代理在本仓库动代码前后必读。功能唯一真相源：`docs/features.md`（冻结版）；
> 冲突时以它为准，改口径 = 改 features.md + 记 ADR。参考母本口径：`docs/reference-situation-puzzle.md`。

## 1. 文档纪律（每次功能更新完成后必须同步，顺序不限；不更新 = 功能没完成）

1. `docs/TASKS.md` **顶部倒序追加**一行：`日期 ｜ 需求 ｜ 主要改动 ｜ 结果与证据`；
2. `README.md` 受影响段落（玩法 / 机制 / 项目结构 / 已知限制）；
3. 新领域词汇或词义变化 → `CONTEXT.md`；项目结构变化 → `docs/PROJECT.md`；
4. 「难逆转 + 后人会困惑 + 真实取舍」的决策 → `docs/adr/`（编号递增，短段落即可）。

文档全集为交付物：`README.md`、`CONTEXT.md`、`CLAUDE.md`、`docs/PROJECT.md`、`docs/TASKS.md`、`docs/adr/`、`docs/features.md`。

## 2. 缓存版本

改**任何** js / css 后，`sw.js` 的 CACHE 版本号 +1（命名 `werewolf-vNN`，从 v1 递增）。
新增 / 删除模块时同步更新 `sw.js` 的 SHELL 预缓存清单。

## 3. 提交前自检

`npm test`（= `node --test`，自动发现 `test/`）必须全绿。
⚠️ 本机实测（node v22.20.0，cmd）：**不要**写 `node --test test/`（把目录当模块加载，报 MODULE_NOT_FOUND）。
⚠️ cmd 下 `2>nul` 重定向可能残留名为 `nul` 的文件（Windows 保留设备名）：提交前 `git status` 确认无 `nul`，有则 `rm -f nul`。
静态骨架自检：`node tools/check_site.cjs`（校验 index.html 引用、sw.js CACHE 格式、wrangler.toml 必填字段）。

## 4. 硬约束（永不简化、不让步）

- 零构建零框架零运行时依赖：原生 HTML/CSS/JS，直接推 GitHub Pages（main 分支），不经过 CI；`shared/` 是浏览器与 Worker 共用的单份 ESM 内核。
- 全站零 emoji，图标一律 SVG；单 `style.css`；仅中文。
- 安全边界永不简化：url-guard（一切服务端出站 fetch 前必过，配 node --test 用例）、快照按座位裁剪、夜里视角冻结（features.md §10 / §4.1.6）。
- 不可逆操作（定刀 / 解药 / 毒药 / 开枪 / 投票 / PK 投票 / 开始游戏）一律两步确认：选择 → 底部固定确认条（热区 ≥44px）→ 提交。
- 移动端硬指标（features.md §1，验收级）：`pointer:coarse` 热区 ≥44px、单列限宽 ~640px、最小字号 ≥12px、弹窗禁 from-opacity 入场动画、flex 防压瘪。
- 部署：`worker/` 目录内 `npx wrangler deploy`；前端推 main 后 GitHub Pages 发布（首次需用户在仓库 Settings → Pages 手动选 main 一次）。

## 5. 部署与环境事实（2026-10-02 核实）

- git 远程 `git@github.com:xxx794665/werewolf.git`（SSH 可达）；本地首提交前把未出生的 `master` 改名 `main`。
- gh CLI 未安装：Pages 开启需用户手动操作一次。
- wrangler 已本机 login；Workers 用 workers.dev 地址（部分地区 DNS 污染，写入 README 已知限制）。
- 后端部署口 `worker/` 不需要 package.json（仅靠 wrangler.toml）。
