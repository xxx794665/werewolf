/* ============================================================
 * worker/src/room.js —— 房间 Durable Object（薄壳，ADR-0001）
 * ------------------------------------------------------------
 * 一个实例 = 一个房间。本壳只做：动作分发 / 状态存取 / alarm 接线 /
 * AI 出站转发；一切玩法判定调用 shared/game.js（经 worker/src/room-logic.js
 * 纯逻辑层），本文件不写规则。
 * 动作统一走 fetch(?action=…) 分发（features.md §9）：
 *   new / join / ready / start / speak / vote / wolf-chat / wolf-target /
 *   guard-protect / seer-check / witch-move / hunter-shoot /
 *   elect-run / elect-speak / elect-withdraw / elect-vote / badge-move /
 *   heartbeat / state / ai_view / drive_ai
 * 持久化：ctx.storage KV（SQLite 后端）单键存整份房间状态；
 * alarm：行动超时 150s / 托管 / 全员失联作废 / 闹钟接管节拍
 *   （room-logic.nextAlarmAt 排程，§4.1 / ADR-0016）。
 * drive_ai（服务端发起 AI 行动，docs/ai-prompts.md §5.3.2 变体）：
 *   房主带 BYO 配置调用 → driveSeat 共享内核（§4.1 ADR-0016 重构）：
 *   组装提示词（shared/prompts.js）→ proxyFetch（45s + 25s 两次尝试：失败 /
 *   格式不合格重试 1 次，§8.4）→ 解析 + 干跑校验 → 提交内核；失败走确定性回退。
 *   alarm autoDrive（§4.1 闹钟接管）：房主失联时以 5s 节拍经同一内核驱动
 *   待行动 AI/托管座位——单次 25s 尝试、体验通道（key 由 Secret 注入）、
 *   失败不立即回退（下拍重试，150s deadline sweep 是最终兜底）。
 *   Key 只在请求内瞬态使用，不落盘不打日志。
 * ============================================================ */

import * as logic from './room-logic.js';
import * as game from '../../shared/game.js';
import { drawRoster } from '../../shared/roster.js';
import { checkUrl } from './url-guard.js';
import { proxyFetch, isDefaultAiUrl, DEFAULT_AI_BASE } from './ai-proxy.js';
import { extractContent, AI_TOKEN_BUDGET, AI_ATTEMPT_TIMEOUTS_MS } from '../../shared/prompts.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const ROOM_ACTIONS = [
  'join', 'ready', 'start', 'speak', 'vote', 'wolf-chat', 'wolf-target',
  'guard-protect', 'seer-check', 'witch-move', 'hunter-shoot',
  'elect-run', 'elect-speak', 'elect-withdraw', 'elect-vote', 'badge-move', 'heartbeat',
];

/* §4.1（ADR-0016）闹钟接管的体验通道配置：与 js/ai.js DEFAULT_AI 同源常量
 * （worker 侧自持一份，ADR-0004 双副本漂移已知晓）；key 走 env.DEFAULT_AI_KEY
 * 注入（与 /api/ai-proxy 同口径，前端不接触凭据）。 */
const AUTO_AI = { baseUrl: DEFAULT_AI_BASE, model: 'cline-pass/deepseek-v4.1-flash' };
const AUTO_DRIVE_TIMEOUT_MS = 25_000; // alarm 单次尝试：不占满 150s，失败下拍重试（§4.1）

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] | 0; // §3 开局均匀随机（DO 侧 crypto）
}

/* [0,1) 浮点随机源（shared/roster.js drawRoster 注入用，DO 侧 crypto） */
const cryptoRand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.driving = false; // drive_ai 串行化（DO await 出站期间可能并发收请求）
  }

  async load() {
    if (this.room) return this.room;
    this.room = (await this.ctx.storage.get('room')) || null;
    if (this.room) {
      /* 重启宽限：心跳视作新鲜（客户端 1.5s 内会重新轮询刷新），避免误判托管 */
      const now = Date.now();
      for (const p of this.room.game.players) {
        if (p && this.room.heartbeats[p.uid] == null) this.room.heartbeats[p.uid] = now;
      }
      if (this.room.heartbeats[this.room.ownerUid] == null) {
        this.room.heartbeats[this.room.ownerUid] = now;
      }
    }
    return this.room;
  }

  async save(room) {
    this.room = room;
    await this.ctx.storage.put('room', room);
  }

  async arm(room) {
    const t = logic.nextAlarmAt(room, Date.now());
    if (t == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(t);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';
    let body = {};
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch (e) {
        body = {};
      }
      if (!body || typeof body !== 'object') body = {};
    }
    const now = Date.now();

    switch (action) {
      case 'new': {
        if (this.room) return json({ error: 'ROOM_EXISTS' }, 409);
        const made = logic.createRoom(url.searchParams.get('code') || '', { nick: body.nick, uid: body.uid }, now);
        if (made.error) return json({ error: 'BAD_REQUEST', message: made.error }, 400);
        await this.save(made.room);
        await this.arm(made.room);
        return json({ ok: true, code: made.room.code, seat: 1, owner: made.room.ownerUid });
      }
      case 'state': {
        const room = await this.load();
        if (!room) return json({ error: 'NOT_FOUND' }, 404);
        const uid = url.searchParams.get('uid') || body.uid;
        const revParam = url.searchParams.get('rev');
        const t = logic.touchHeartbeat(room, uid, now); // 轮询即心跳（§7.7）
        if (t.changed) await this.save(t.room);
        else this.room = t.room;
        const seat = logic.seatOfUid(t.room, uid);
        if (seat == null) return json({ error: 'NOT_IN_ROOM' }, 404);
        const rev = t.room.revs[seat] || 0;
        if (revParam != null && Number(revParam) === rev) return json({ unchanged: true }); // 几十字节短回包（§2）
        return json({ ...logic.snapshotFor(t.room, seat), rev });
      }
      case 'ai_view': {
        const room = await this.load();
        if (!room) return json({ error: 'NOT_FOUND' }, 404);
        if (body.uid !== room.ownerUid) return json({ error: 'FORBIDDEN' }, 403); // owner 专属（ADR-0002）
        const seat = Number(body.seat);
        const p = room.game.players[seat - 1];
        if (!p || (!p.isAI && !room.hosted.includes(seat))) {
          return json({ error: 'FORBIDDEN', message: '只能查看 AI 座位或托管中的座位' }, 403);
        }
        return json({ ok: true, view: logic.aiView(room, seat).view });
      }
      case 'drive_ai': {
        return this.driveAI(body, now);
      }
      default: {
        if (!ROOM_ACTIONS.includes(action)) return json({ error: 'UNKNOWN_ACTION' }, 400);
        const room = await this.load();
        if (!room) return json({ error: 'NOT_FOUND' }, 404);
        const out = logic.applyAction(room, action, body, {
          now,
          seed: action === 'start' ? randomSeed() : undefined,
          // ADR-0009：开局名册（AI 人格 × 网名，与身份无关）在 DO 内部抽取，
          // 与 seed 同模式经 ctx 注入，不经客户端中转；board = 房主大厅选板
          // （§1.1，ADR-0013）随 start 请求体透传，内核校验合法性
          roster:
            action === 'start'
              ? drawRoster(room.game.players.filter((p) => !p).length, cryptoRand)
              : undefined,
          board: action === 'start' ? body.board : undefined,
        });
        if (out.error) return json({ error: 'ACTION_REJECTED', message: out.error }, 400);
        if (out.persist !== false) {
          await this.save(out.room);
          await this.arm(out.room);
        } else {
          this.room = out.room; // 纯心跳：不落盘（下次真实提交会带上最新心跳）
        }
        return json({ ok: true, ...(out.data || {}) });
      }
    }
  }

  /**
   * 服务端发起 AI 座位行动（§5.3.2 路径，HTTP 壳）：权限 / 串行化 / 响应码
   * 形状与旧版一字不差；核心出站与提交下沉 driveSeat 共享内核（§4.1 ADR-0016）。
   */
  async driveAI(body, now) {
    const room = await this.load();
    if (!room) return json({ error: 'NOT_FOUND' }, 404);
    if (body.uid !== room.ownerUid) return json({ error: 'FORBIDDEN' }, 403);
    if (this.driving) return json({ error: 'BUSY' }, 409); // 出站期间串行化
    const seat = game.pendingSeat(room.game);
    if (seat == null) return json({ error: 'NO_PENDING' }, 400);
    const p = room.game.players[seat - 1];
    if (!p || (!p.isAI && !room.hosted.includes(seat))) {
      return json({ error: 'FORBIDDEN', message: '当前待行动座位不是 AI 座位或托管中的座位' }, 403);
    }
    if (!body.baseUrl || !body.model) return json({ error: 'BAD_REQUEST', message: '缺少 baseUrl / model' }, 400);

    this.driving = true;
    try {
      /* HTTP drive_ai（房主带 BYO）：45s + 25s 两次尝试，失败 / 格式不合格
       * 重试 1 次，两次皆败立即走确定性回退（§8.4 现状不变） */
      const out = await this.driveSeat(
        seat,
        { baseUrl: body.baseUrl, model: body.model, maxTokens: body.maxTokens, key: body.key },
        { timeouts: AI_ATTEMPT_TIMEOUTS_MS, fallback: true }
      );
      if (out.error === 'STALE') return json({ error: 'STALE', message: '座位状态已变化，请重新轮询' }, 409);
      if (out.error) return json({ error: 'BAD_REQUEST', message: out.error }, 400);
      return json({ ok: true, acted: seat, via: out.via });
    } finally {
      this.driving = false;
    }
  }

  /**
   * 驱动内核（HTTP drive_ai 与闹钟 autoDrive 共享，§4.1 ADR-0016 重构）：
   * 组装提示词 → url-guard → proxyFetch（超时序列参数化：HTTP 45s+25s /
   * alarm 单次 25s）→ digestAIReply 解析 + 干跑校验 → 提交内核。
   * opts.fallback 决定无可用回复时是否立即走确定性回退（HTTP=立即，现状不变；
   * alarm=不回退，下个 5s 节拍重试，150s deadline sweep 是最终兜底）。
   * 成功即 save + arm（调用方勿再基于旧房间排程）。
   * 返回 { room, via } 或 { error: 'STALE' | 提示词组装错误 }。
   */
  async driveSeat(seat, cfg, opts) {
    const fresh = await this.load(); // 出站前重读最新状态（alarm 可能已推进）
    if (game.pendingSeat(fresh.game) !== seat) return { error: 'STALE' };
    const req = logic.buildAIRequest(fresh, seat, cfg);
    if (req.error) return { error: req.error };
    const phase = logic.phaseOf(fresh.game);

    /* 请求 → 解析 → 干跑校验；重试节奏随 opts.timeouts（§8.4）；
       starved 放宽一倍预算占用本次重试 */
    let pick = null; // 校验通过的 AI 回复 { chat, action }
    let lastChat = null; // 狼阶段最后一次解析出的密聊（重试失败也带上，§4.1.1）
    const guard = checkUrl(req.url);
    if (guard == null) {
      /* 体验通道：调用方未带 key 且目标是体验通道上游 → 注入 Secret
         （与 /api/ai-proxy 同口径；alarm autoDrive 的 cfg.key 恒空 → 走此路径） */
      const outKey = cfg.key || (this.env.DEFAULT_AI_KEY && isDefaultAiUrl(req.url) ? this.env.DEFAULT_AI_KEY : '');
      let budget = req.body.max_tokens;
      for (const timeoutMs of opts.timeouts) {
        const r = await this.fetchOnce(req.url, req.body, outKey, budget, timeoutMs);
        if (r.starved) budget = Math.min(AI_TOKEN_BUDGET.max, budget * 2); // 思考烧光预算 → 放宽一倍
        const d = logic.digestAIReply(fresh.game, phase, seat, r.content);
        if (d.chat) lastChat = d.chat;
        if (d.action) {
          pick = d;
          break;
        }
      }
    }

    /* 提交（AI 结果或回退）都基于提交瞬间的最新状态；再撞 STALE 就回错 */
    let out = null;
    let via = null;
    let latest = await this.load();
    if (game.pendingSeat(latest.game) === seat) {
      if (pick) {
        // 狼阶段一次调用两段提交：先密聊（可选），后投票
        if (pick.chat) {
          const c = logic.applyGameAction(latest, { type: 'wolf_chat', seat, text: pick.chat }, Date.now());
          if (!c.error) {
            out = c;
            latest = c.room;
          }
        }
        const v = logic.applyGameAction(latest, pick.action, Date.now());
        if (!v.error) {
          out = v;
          via = 'ai';
        }
      } else if (opts.fallback !== false) {
        if (lastChat) {
          const c = logic.applyGameAction(latest, { type: 'wolf_chat', seat, text: lastChat }, Date.now());
          if (!c.error) {
            out = c;
            latest = c.room;
          }
        }
        const fb = logic.applyFallbackFor(latest, seat, Date.now()); // 只聊了天没投票 → 随机票兜底
        if (!fb.error) {
          out = fb;
          via = 'fallback';
        }
      }
      /* alarm 路径（fallback=false）：无可用回复不动状态，返回 STALE 上抛给
         autoDrive 当作本拍无动作——下个 5s 节拍重试（§4.1） */
    }
    if (out == null) return { error: 'STALE' };
    await this.save(out.room);
    await this.arm(out.room);
    return { room: out.room, via };
  }

  /**
   * §4.1（ADR-0016）闹钟接管：房主失联且待行动座位为 AI / 托管时，经
   * driveSeat 用体验通道驱动一拍。与 HTTP drive_ai 经 this.driving 互斥
   * （忙则本拍让位）；单次 25s 尝试、失败不回退。返回推进后的房间或 null。
   */
  async autoDrive(now) {
    if (this.driving) return null; // 出站期间收到 drive_ai → HTTP 优先，本拍跳过
    const room = await this.load();
    if (!room) return null;
    if (!logic.alarmDriveDue(room, now)) return null;
    const seat = game.pendingSeat(room.game);
    if (seat == null) return null;
    this.driving = true;
    try {
      const out = await this.driveSeat(
        seat,
        { baseUrl: AUTO_AI.baseUrl, model: AUTO_AI.model, key: '' }, // key 空 → Secret 注入体验通道
        { timeouts: [AUTO_DRIVE_TIMEOUT_MS], fallback: false }
      );
      return out.room || null; // 失败（无可用回复）不改状态 → 下拍重试
    } finally {
      this.driving = false;
    }
  }

  /** 单次上游尝试（不重试）：仅调用已过 url-guard 的 url。
   *  返回 { content, starved }：content = null 为请求失败 / 空正文；
   *  starved = 正文为空且疑似截断（finish=length / 伪 500），调用方放宽
   *  一倍预算后重试（§8.4，与客户端 requestOnce 同口径）。 */
  async fetchOnce(url, reqBody, key, budget, timeoutMs) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`; // 瞬态透传，不落盘不打日志
    const out = await proxyFetch(url, headers, JSON.stringify({ ...reqBody, max_tokens: budget }), timeoutMs);
    if (out.error) return { content: null, starved: false };
    const { content, finish } = extractContent(out.text);
    if (content.trim()) return { content, starved: false }; // 截断但有正文也用（解析端按 250 字上限按句截断）
    return {
      content: null,
      starved: finish === 'length' || (out.status >= 500 && out.text.indexOf('empty response content') >= 0),
    };
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const out = logic.sweep(room, Date.now());
    if (out.changed) await this.save(out.room);
    else this.room = out.room;
    /* §4.1（ADR-0016）闹钟接管：sweep 之后按 alarmDriveDue 驱动待行动
       AI / 托管座位（driveSeat 内含 save + arm） */
    await this.autoDrive(Date.now());
    /* arm 必须基于 autoDrive 之后的最新房间——拿 sweep 后的旧房间算
       nextAlarmAt 会把 alarm 排进过去 → max(now+1) 钳成 1ms 热循环（D-8） */
    const latest = await this.load();
    if (latest) await this.arm(latest);
  }
}
