/* ============================================================
 * test/roster.test.mjs —— shared/roster.js 测试（node --test 自动发现）
 * 口径对照 docs/features.md §7.5 / ADR-0009：开局名册 = 人格 × 网名，
 * 人格洗牌不重复、网名全局唯一、**与身份完全无关**（池子卫生黑名单）。
 * 固定种子随机源，全部用例可复现。
 * ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawRoster, PERSONA_NICKS, NICK_MAX, PERSONA_MAX } from '../shared/roster.js';
import { PERSONAS } from '../shared/prompts.js';

/** 种子伪随机源（mulberry32 同族，[0,1)），可复现。 */
function seeded(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('抽取：count 边界（0 空、8 满）与条目形状', () => {
  assert.equal(drawRoster(0, seeded(1)).length, 0, '满员开局（0 个 AI）→ 空名册');
  const r = drawRoster(8, seeded(42));
  assert.equal(r.length, 8);
  for (const e of r) {
    assert.equal(typeof e.nick, 'string');
    assert.ok(e.nick.length >= 1 && e.nick.length <= NICK_MAX, `nick 长度 1–${NICK_MAX}`);
    assert.ok(PERSONAS.includes(e.persona), '人格必须出自 PERSONAS');
    assert.ok(e.persona.length >= 1 && e.persona.length <= PERSONA_MAX);
  }
});

test('抽取：人格一局不重复、网名全局唯一、贴合人格池', () => {
  const r = drawRoster(8, seeded(7));
  const personas = new Set(r.map((e) => e.persona));
  const nicks = new Set(r.map((e) => e.nick));
  assert.equal(personas.size, 8, '8 个 AI 八款人格（洗牌不重复抽取）');
  assert.equal(nicks.size, 8, '网名全局唯一');
  for (const e of r) {
    const pool = PERSONA_NICKS[PERSONAS.indexOf(e.persona)];
    assert.ok(pool.includes(e.nick), `网名「${e.nick}」必须出自其人格的池子`);
  }
});

test('抽取：同种子可复现、不同种子大概率不同、非法输入抛错', () => {
  assert.deepEqual(drawRoster(5, seeded(99)), drawRoster(5, seeded(99)), '同 seed 同名册');
  assert.notDeepEqual(drawRoster(8, seeded(1)), drawRoster(8, seeded(2)));
  assert.throws(() => drawRoster(9, seeded(1)), /roster:/, 'count 超过人格数 → 抛错');
  assert.throws(() => drawRoster(-1, seeded(1)), /roster:/);
  assert.throws(() => drawRoster(3.5, seeded(1)), /roster:/);
  assert.throws(() => drawRoster(3), /roster:/, '缺随机源 → 抛错');
});

test('池子卫生：与 PERSONAS 对齐、全中文、无角色暗示词、跨池无重名', () => {
  assert.equal(PERSONA_NICKS.length, PERSONAS.length, '池子与 8 款人格一一对应');
  const all = [];
  for (const pool of PERSONA_NICKS) {
    assert.ok(pool.length >= 8, '每池 ≥ 8 名（≥ count 上限，候选必非空）');
    for (const nick of pool) {
      assert.match(nick, /^[\u4e00-\u9fff]+$/, `网名「${nick}」必须纯简体中文（全站仅中文、零 emoji）`);
      assert.ok(nick.length <= 8, `网名「${nick}」应简短（≤ 8 字）`);
      assert.doesNotMatch(
        nick,
        /狼|预言|女巫|巫|猎人|猎|村民|民|神|查杀|金水|悍跳|对跳|屠|警长|守卫/,
        `网名「${nick}」含角色暗示词——名字与身份无关是 ADR-0009 的硬口径`
      );
      all.push(nick);
    }
  }
  assert.equal(new Set(all).size, all.length, '全部池子之间无重名（全局唯一可满足的前提）');
});
