/* ============================================================
 * worker/src/room.js —— 房间 Durable Object（薄壳，ADR-0001）
 * ------------------------------------------------------------
 * 一个实例 = 一个房间。本壳只做：动作分发 / 状态存取 / alarm 接线 /
 * AI 出站转发；一切玩法判定调用 shared/game.js（经 worker/src/room-logic.js
 * 纯逻辑层），本文件不写规则。
 * 动作统一走 fetch(?action=…) 分发（features.md §9）：
 *   new / join / ready / start / speak / vote / wolf-target / seer-check /
 *   witch-move / hunter-shoot / heartbeat / state / ai_view / drive_ai
 * 持久化：ctx.storage KV（SQLite 后端）单键存整份房间状态；
 * alarm：行动超时 150s / 托管 / 房主作废（room-logic.nextAlarmAt 排程）。
 * drive_ai（服务端发起 AI 行动，docs/ai-prompts.md §5.3.2 变体）：
 *   房主带 BYO 配置调用 → DO 组装提示词（shared/prompts.js）→ proxyFetch
 *   （45s + 25s 两次尝试：失败 / 格式不合格重试 1 次，§8.4）→ 解析 + 干跑
 *   校验 → 提交内核；失败走确定性回退。
 *   Key 只在请求内瞬态使用，不落盘不打日志。
 * ============================================================ */

import * as logic from './room-logic.js';
import * as game from '../../shared/game.js';
import { drawRoster } from '../../shared/roster.js';
import { checkUrl } from './url-guard.js';
import { proxyFetch, isDefaultAiUrl } from './ai-proxy.js';
import { extractContent, AI_TOKEN_BUDGET, AI_ATTEMPT_TIMEOUTS_MS } from '../../shared/prompts.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const ROOM_ACTIONS = [
  'join', 'ready', 'start', 'speak', 'vote', 'wolf-chat', 'wolf-target',
  'seer-check', 'witch-move', 'hunter-shoot', 'heartbeat',
];

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
          // 与 seed 同模式经 ctx 注入，不经客户端中转
          roster:
            action === 'start'
              ? drawRoster(room.game.players.filter((p) => !p).length, cryptoRand)
              : undefined,
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
   * 服务端发起 AI 座位行动（§5.3.2 路径）：按 docs/ai-prompts.md 数据契约
   * 组装请求（history 窗口 + 该座位 roleCard + buildMessages）→ url-guard →
   * proxyFetch（45s + 25s 两次尝试：请求失败 / 未回复符合格式的回复重试 1 次，
   * §8.4）→ digestAIReply 解析 + 干跑校验 → 提交内核；任一失败走 §8.4
   * 确定性回退（与客户端路径同构，DO 是行动合法性的最终权威）。
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
      const fresh = await this.load(); // 出站前重读最新状态（alarm 可能已推进）
      if (game.pendingSeat(fresh.game) !== seat) return json({ error: 'STALE', message: '座位已行动' }, 409);
      const req = logic.buildAIRequest(fresh, seat, { baseUrl: body.baseUrl, model: body.model, maxTokens: body.maxTokens });
      if (req.error) return json({ error: 'BAD_REQUEST', message: req.error }, 400);
      const phase = logic.phaseOf(fresh.game);

      /* 请求 → 解析 → 干跑校验；失败 / 未回复符合格式的回复重试 1 次（45s + 25s，
         总预算 < 150s 行动超时的一半，§8.4）；starved 放宽一倍预算占用本次重试 */
      let pick = null; // 校验通过的 AI 回复 { chat, action }
      let lastChat = null; // 狼阶段最后一次解析出的密聊（重试失败也带上，§4.1.1）
      const guard = checkUrl(req.url);
      if (guard == null) {
        /* 体验通道：房主未带 key 且目标是体验通道上游 → 注入 Secret（与 /api/ai-proxy 同口径） */
        const outKey = body.key || (this.env.DEFAULT_AI_KEY && isDefaultAiUrl(req.url) ? this.env.DEFAULT_AI_KEY : '');
        let budget = req.body.max_tokens;
        for (const timeoutMs of AI_ATTEMPT_TIMEOUTS_MS) {
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
        } else if (lastChat) {
          const c = logic.applyGameAction(latest, { type: 'wolf_chat', seat, text: lastChat }, Date.now());
          if (!c.error) {
            out = c;
            latest = c.room;
          }
          const fb = logic.applyFallbackFor(latest, seat, Date.now()); // 只聊了天没投票 → 随机票兜底
          if (!fb.error) {
            out = fb;
            via = 'fallback';
          }
        }
        if (out == null) {
          const fb = logic.applyFallbackFor(latest, seat, Date.now());
          if (!fb.error) {
            out = fb;
            via = 'fallback';
          }
        }
      }
      if (out == null) return json({ error: 'STALE', message: '座位状态已变化，请重新轮询' }, 409);
      await this.save(out.room);
      await this.arm(out.room);
      return json({ ok: true, acted: seat, via });
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
    await this.arm(out.room);
  }
}
