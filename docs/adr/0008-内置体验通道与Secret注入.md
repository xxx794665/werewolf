# ADR-0008：内置体验通道与 Secret 注入（2026-10-03）

## 背景

原设计为纯 BYO：用户必须先在「AI 设置」填 baseUrl / Key / 模型才能体验 AI。
试用用户（没有自己的接口）开局只会得到兜底发言与随机行动，无法体验核心玩法。

## 决策

后端内置一个默认 AI 通道（体验通道），未配置 BYO 的请求自动回退到它：

- **非机密部分进源码**：`baseUrl` 与 `model` 以常量存在于 `js/ai.js`（前端拼信封需要）与
  `worker/src/ai-proxy.js`（注入判断需要），两边刻意各持一份（同 ADR-0004 的漂移口径）。
- **机密部分走 Worker Secret**：`DEFAULT_AI_KEY` 通过 `wrangler secret put` / API 配置，
  绝不进源码、wrangler.toml、文档或前端。
- **注入条件强绑定**：仅当请求**未带 `authorization` 头**且**出站 URL 以体验通道 baseUrl 开头**
  时，Worker（`/api/ai-proxy` 路由与 DO `drive_ai` 两处对称注入）才补
  `Authorization: Bearer {DEFAULT_AI_KEY}`。因此：
  - key 永远只发往体验通道上游，不会被「带 Bearer 打任意 url-guard 放行主机」的请求外泄
    （否则中转即成 key 外泄通道——这是本决策防住的最大风险）；
  - 自带 key 的 BYO 请求原样透传，不覆盖；
  - 他域请求永不注入。

## 取舍（真实代价，后人须知）

- **共享 key 被刷**：体验通道对所有匿名用户共享同一把 key，额度可能被刷穿。
  靠既有 `aiProxyLimited`（同 IP 5000 次/日）兜底；key 失效时体验通道退化为
  上游 401 → 确定性回退（§8.4），游戏不砖，换 key 只需重设 Secret，不动代码。
- **上游依赖**：体验通道上游限速 / 下线只影响未配置用户；BYO 用户不受影响。

## 结果

- 未配置用户开箱即玩（单机直接可玩；联机房主不配置也照常驱动 AI 座位）。
- 「测试连接」在空配置下测的就是体验通道，用户能立刻验证可用性。
