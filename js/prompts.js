/* ============================================================
 * js/prompts.js —— 角色提示词（浏览器入口，薄转发）
 * ------------------------------------------------------------
 * 实现已上移 shared/prompts.js：提示词与 buildMessages 是浏览器与
 * Worker 共用的单份模块（ADR-0001 单份原则；联机若采用服务端发起的
 * AI 座位，Worker 侧直接 import shared/prompts.js，见 docs/ai-prompts.md）。
 * 本文件只为保留既有导入路径（index.html 模块序、js/ai.js 的
 * import "./prompts.js"）：
 *   import { buildMessages, ROLE_PROMPTS } from "./prompts.js";
 * 设计说明与请求契约：docs/ai-prompts.md。
 * ============================================================ */

export * from "../shared/prompts.js";
