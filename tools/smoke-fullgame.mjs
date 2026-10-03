/* 整局冒烟（非 node --test 用例，一次性自检脚本）：
 * 3 真人 + 6 AI 开局 → 真人座位按回退派生动作提交、AI 座位走 drive_ai
 * （fetch 桩成快速失败 → 走 §8.4 确定性回退），直到 revealed。
 * 运行：node tools/smoke-fullgame.mjs
 */
import { Room } from '../worker/src/room.js';
import * as game from '../shared/game.js';

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarmAt = null;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.map.set(k, v);
  }
  async delete(k) {
    this.map.delete(k);
  }
  async setAlarm(t) {
    this.alarmAt = t;
  }
  async getAlarm() {
    return this.alarmAt;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}

/* 桩掉全局 fetch：快速失败（模拟上游不可达 → 回退路径） */
globalThis.fetch = async () => {
  throw new Error('smoke: upstream unreachable');
};

const room = new Room({ storage: new FakeStorage() }, {});
const rpc = async (action, body, q = '') => {
  const url = `https://do/?action=${action}${q}`;
  const res = await room.fetch(body ? new Request(url, { method: 'POST', body: JSON.stringify(body) }) : new Request(url));
  return { status: res.status, json: await res.json().catch(() => null) };
};

await rpc('new', { nick: '甲', uid: 'o1' }, '&code=SMOKE1');
await rpc('join', { nick: '乙', uid: 'o2' });
await rpc('join', { nick: '丙', uid: 'o3' });
for (const u of ['o1', 'o2', 'o3']) await rpc('ready', { uid: u, ready: true });
const started = await rpc('start', { uid: 'o1' });
if (!started.json.ok) throw new Error('start 失败: ' + JSON.stringify(started.json));

const ACTION_OF = {
  'night:wolf': 'wolf-target',
  'night:seer': 'seer-check',
  'night:witch': 'witch-move',
  'day:night_hunter': 'hunter-shoot',
  'day:hunter': 'hunter-shoot',
  'day:vote': 'vote',
  'day:pk_vote': 'vote',
};
const BODY_OF = {
  'night:wolf': (fb) => ({ target: fb.state.night.blade }),
  'night:seer': (fb) => ({ target: fb.state.seerChecks[fb.state.seerChecks.length - 1].target }),
  'night:witch': () => ({ move: 'skip' }),
  'day:night_hunter': () => ({ target: null }),
  'day:hunter': () => ({ target: null }),
  'day:vote': () => ({ target: null }),
  'day:pk_vote': () => ({ target: null }),
};

const via = { ai: 0, fallback: 0, human: 0 };
let guard = 0;
while (guard++ < 500) {
  await room.load();
  if (room.room.game.phase === 'revealed') break;
  const pending = game.pendingSeat(room.room.game);
  if (pending == null) break;
  const p = room.room.game.players[pending - 1];
  if (!p.isAI && !room.room.hosted.includes(pending)) {
    const kind = `${room.room.game.phase}:${room.room.game.subPhase}`;
    if (kind === 'night:wolf') {
      // §4.1.1 狼人真人：先密聊一句再投票（目标取第一个存活座位；刀队友/自刀均合法）
      const alive = room.room.game.players.filter((x) => x && x.alive).map((x) => x.seat);
      const c = await rpc('wolf-chat', { uid: p.uid, text: '听我口型，白天别露馅' });
      if (c.status !== 200) throw new Error('wolf-chat: ' + JSON.stringify(c.json));
      const v = await rpc('wolf-target', { uid: p.uid, target: alive[0] });
      if (v.status !== 200) throw new Error('wolf-target: ' + JSON.stringify(v.json));
      via.human++;
    } else {
      // 其余真人座位：以该座位 uid 提交（弃票 / 跳过 / 兜底句），模拟真人玩家
      const act = ACTION_OF[kind] || 'speak';
      const body = (BODY_OF[kind] || (() => ({ text: '我先听听大家的意见。' })))(
        game.applyFallback(room.room.game, pending)
      );
      const r = await rpc(act, { uid: p.uid, ...body });
      if (r.status !== 200) throw new Error(`human ${act}: ${JSON.stringify(r.json)}`);
      via.human++;
    }
  } else {
    const r = await rpc('drive_ai', { uid: 'o1', baseUrl: 'https://api.openai.com/v1', model: 'm', key: 'k' });
    if (r.status === 200) via[r.json.via]++;
    else throw new Error('drive_ai: ' + JSON.stringify(r.json));
  }
  await room.alarm();
}

const final = await rpc('state', { uid: 'o1' }, '&uid=o1');
console.log('终局:', final.json.phase, '| winner:', final.json.winner, '| 步数:', guard, '| via:', JSON.stringify(via));
const evs = final.json.events;
console.log('公开事件数:', evs.length, '| 末事件:', JSON.stringify(evs[evs.length - 1]));
console.log('全员亮牌:', final.json.players.every((p) => p && p.role != null));
if (final.json.phase !== 'revealed') {
  console.error('FAIL: 未到终局');
  process.exit(1);
}
