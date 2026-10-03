/* ============================================================
 * shared/roster.js —— AI 名册：人格 × 网名池与开局抽取（纯函数，零 I/O）
 * ------------------------------------------------------------
 * 口径（ADR-0009）：开局时为每个 AI 座位随机抽取一对「人格 + 网名」——
 *   - 人格从 PERSONAS（shared/prompts.js，8 款）洗牌**不重复**抽取：
 *     一局之内两个 AI 不共用一款口吻；
 *   - 网名从该人格的池子里抽，且全局不重复；
 *   - 名字只贴合人格的言行风格，**与抽中的身份完全无关**——池子里
 *     不出现任何角色暗示词（狼 / 预言 / 女巫 / 猎人 / 村民 / 神…，
 *     test/roster.test.mjs 有黑名单断言），玩家无法从网名猜身份。
 * 消费方：
 *   - Worker `POST /api/ai-roster`（worker/src/index.js）：单机开局拉取；
 *   - DO 开局（worker/src/room.js）：联机 start 时内部直接抽取（不经 HTTP，
 *     与 seed 同模式经 ctx 注入 room-logic）；
 *   - 浏览器兜底（js/ai.js fetchRoster）：接口不可达时本地用同一份池子抽。
 * rand 注入（返回 [0,1) 浮点的函数）：生产传 crypto.getRandomValues 派生，
 *   测试传种子伪随机可复现。本模块不允许出现 DOM / fetch / crypto / Date。
 * ============================================================ */

import { PERSONAS } from './prompts.js';

export const NICK_MAX = 20; // 网名长度上限（与内核 roster 校验、prompts.js roleCard 校验同口径）
export const PERSONA_MAX = 120; // 人格描述长度上限（prompts.js roleCard.persona 同口径）

/* 与 shared/prompts.js PERSONAS 下标一一对应的 8 池中文网名。
 * 起名纪律：简体中文、≤ 8 字、全部池子之间无重名、不含角色暗示词
 * （黑名单断言见 test/roster.test.mjs「池子卫生」）。 */
export const PERSONA_NICKS = [
  // 盘逻辑型
  [
    '逻辑闭环怪',
    '数据不说谎',
    '三段论钉子户',
    '反证法爱好者',
    '冷静观测者',
    '列点狂魔',
    '概率主义者',
    '证据链工匠',
    '复盘小能手',
    '慢慢推理中',
    '排除法信徒',
    '理性不缺席',
  ],
  // 直率冲锋型
  [
    '有话直说',
    '先投为敬',
    '正面刚选手',
    '一针见血本血',
    '火力全开',
    '直线球不拐弯',
    '敢说敢当',
    '忍不住要说',
    '先声夺人',
    '硬核嘴替',
    '谁赞成谁反对',
    '火药味本人',
  ],
  // 乐子人型
  [
    '整活小能手',
    '快乐源泉本泉',
    '节目效果拉满',
    '梗王附体',
    '乐子最重要',
    '气氛组组长',
    '抽象派代表',
    '吃瓜第一名',
    '今天也很欢乐',
    '正经不过三秒',
    '玩的就是心跳',
    '上桌先整活',
  ],
  // 老实人型
  [
    '有啥说啥',
    '老实交代',
    '掏心窝子',
    '不会撒谎啊',
    '单纯不装',
    '真诚必杀技',
    '说了别骗我',
    '实在人一个',
    '心直口快',
    '我就信你了',
    '憨憨发言席',
    '全都告诉你',
  ],
  // 戏精型
  [
    '以人格担保',
    '影帝营业中',
    '加戏十级学者',
    '掌声在哪里',
    '本局主角是我',
    '戏剧性反转',
    '闪亮登场',
    '欠我一座小金人',
    '气场两米八',
    '麦克风给我',
    '聚光灯已就位',
    '演完再说话',
  ],
  // 暴民型
  [
    '投他准没错',
    '跟我冲',
    '直觉永不眠',
    '嗓门大有理',
    '节奏大师本师',
    '吵起来吵起来',
    '大势所趋',
    '舆论风向标',
    '人多力量大',
    '就投他了',
    '风往哪吹',
    '一呼百应',
  ],
  // 老油条型
  [
    '让子弹飞一会',
    '见怪不怪',
    '稳住别浪',
    '后发制人',
    '不站队主义',
    '先观望一下',
    '姜还是老的辣',
    '留一手',
    '细水长流',
    '和稀泥专家',
    '老江湖路过',
    '我再想想',
  ],
  // 寡言刀客型
  [
    '话少但准',
    '一语中的',
    '沉默是金',
    '字字珠玑',
    '懒得解释',
    '最后再说话',
    '点到为止',
    '安静观察家',
    '惜字如金',
    '一开口就到要害',
    '少说多看',
    '出手即真章',
  ],
];

/**
 * 抽取一局名册：count 条 { nick, persona }。
 * 人格 Fisher–Yates 洗牌取前 count 款（一局内不重复）；网名从对应池子取
 * 未用过的（全局唯一；池大小 12 ≥ count 上限 8，候选必非空）。
 * count = 0 合法（满员开局无 AI）→ 空数组；count 越界 / rand 缺失 → 抛 Error。
 */
export function drawRoster(count, rand) {
  if (!Number.isInteger(count) || count < 0 || count > PERSONAS.length) {
    throw new Error('roster: count 必须是 0–' + PERSONAS.length + ' 的整数');
  }
  if (typeof rand !== 'function') throw new Error('roster: 缺少随机源 rand（[0,1) 浮点函数）');
  const idx = PERSONAS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const used = new Set();
  return idx.slice(0, count).map((pi) => {
    const pool = PERSONA_NICKS[pi].filter((n) => !used.has(n));
    if (pool.length === 0) throw new Error('roster: 网名池耗尽（池大小必须 ≥ count 上限）');
    const nick = pool[Math.floor(rand() * pool.length)];
    used.add(nick);
    return { nick, persona: PERSONAS[pi] };
  });
}
