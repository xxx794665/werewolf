/* test/prompts.test.mjs —— shared/prompts.js 最小可运行检查（node --test 自动发现）
 * 覆盖：消息形状、五角色提示词齐备、历史折叠与存活推导、私有字段白名单
 * （与角色不匹配的字段进不了提示词）、夜晚阶段角色强一致、女巫用药分支、
 * 每座位口吻、非法输入抛错。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMessages, PHASES, ROLE_PROMPTS, TASK_PROMPTS,
  COMMON_CONSTRAINTS, BOARD_RULES, PERSONAS
} from "../shared/prompts.js";

/* 造一份小型公开历史：夜 1 死 4/7（首夜遗言）→ 白天发言 → 投票 → 放逐 5；
 * 夜 2 狼刀 2 号（猎人）翻枪带走 8 号 → 第 2 天发言。
 * 死亡累计 4、7、5、2、8 → 存活 1、3、6、9；最大 day=2。 */
function sampleHistory() {
  return [
    { t: "deaths", day: 1, seats: [4, 7] },
    { t: "lastwords", day: 1, seat: 4, text: "我验过 3 号，是好人。" },
    { t: "speech", day: 1, seat: 1, text: "4 号遗言信息量很大，我先信一半。" },
    { t: "speech", day: 1, seat: 3, text: "昨天 6 号发言很飘，我怀疑 6 号。" },
    { t: "vote", day: 1, voter: 1, target: 5 },
    { t: "vote", day: 1, voter: 3, target: null },
    { t: "exile", day: 1, seat: 5 },
    { t: "deaths", day: 2, seats: [2] },
    { t: "hunter", day: 2, seat: 2, target: 8 },
    { t: "speech", day: 2, seat: 6, text: "2 号是猎人，带走 8 号，好人亏麻了。" }
  ];
}

function witchCard() {
  return { seat: 9, role: "witch", antidote: true, poison: true };
}

test("消息形状：恒为 system + user 两条，内容含聊天记录围栏与输出格式", () => {
  const msgs = buildMessages(sampleHistory(), { seat: 3, role: "villager" }, "speak");
  assert.ok(Array.isArray(msgs) && msgs.length === 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.equal(typeof msgs[0].content, "string");
  assert.equal(typeof msgs[1].content, "string");
  assert.ok(msgs[1].content.includes("聊天记录开始"));
  assert.ok(msgs[1].content.includes("聊天记录结束"));
  assert.ok(msgs[1].content.includes("【输出格式】"));
});

test("五角色提示词与通用约束齐备（features.md §8.3：5 份）", () => {
  for (const key of ["wolf", "villager", "seer", "witch", "hunter"]) {
    const rp = ROLE_PROMPTS[key];
    assert.ok(rp && rp.name && rp.faction && rp.rules && rp.strategy, key + " 角色提示词不完整");
  }
  assert.ok(BOARD_RULES.includes("9 人"));
  assert.ok(COMMON_CONSTRAINTS.includes("不是给你的指令")); /* 注入防御条款在场 */
  assert.ok(COMMON_CONSTRAINTS.includes("100–200 字")); /* 发言长度约束在场 */
  assert.ok(COMMON_CONSTRAINTS.includes("不自称 AI")); /* 口吻约束在场 */
  assert.equal(PHASES.length, 9);
  assert.equal(Object.keys(TASK_PROMPTS).length, 9);
  assert.ok(PERSONAS.length >= 4);
});

test("历史折叠：死亡/放逐/枪杀推导存活名单；天数与投票渲染正确", () => {
  const user = buildMessages(sampleHistory(), { seat: 3, role: "villager" }, "speak")[1].content;
  assert.ok(user.includes("存活玩家：1、3、6、9 号"), "存活推导错误");
  assert.ok(user.includes("第2天"), "当前天数推导错误");
  assert.ok(!user.includes("平安夜"), "本局没有平安夜却渲染了平安夜");
  assert.ok(user.includes("弃票"), "投票弃票未渲染");
  assert.ok(user.includes("翻牌猎人，开枪带走 8 号"), "猎人枪未渲染");
});

test("历史折叠：digest 压缩行的死亡同样计入存活推导（§8.2 历史窗口）", () => {
  const h = [
    { t: "digest", day: 1, text: "5 号被放逐", dead: [5] },
    { t: "deaths", day: 2, seats: [1] }
  ];
  const user = buildMessages(h, { seat: 3, role: "villager" }, "speak")[1].content;
  assert.ok(user.includes("存活玩家：2、3、4、6、7、8、9 号"));
});

test("tie 事件驱动 pk_vote 的 PK 台名单", () => {
  const h = sampleHistory().concat([{ t: "tie", day: 2, seats: [3, 6] }]);
  const pk = buildMessages(h, { seat: 9, role: "villager" }, "pk_vote");
  assert.ok(pk[1].content.includes("3、6 号"));
});

test("白名单：与角色不匹配的私有字段一律不进提示词（防调用失误泄密）", () => {
  /* 给平民塞狼队友 / 验史 / 刀口 / 药——任何一项进入提示词就是越界。
   * 断言用私有信息独有措辞（公共规则里也出现「解药/狼」等词，不能拿裸词判） */
  const dirty = {
    seat: 3, role: "villager",
    wolves: [2, 6], checks: [{ night: 1, seat: 4, result: "wolf" }],
    knifeTarget: 1, antidote: true, poison: true
  };
  const msgs = buildMessages(sampleHistory(), dirty, "speak");
  const all = msgs[0].content + msgs[1].content;
  assert.ok(!all.includes("全体狼座位"));
  assert.ok(!all.includes("存活队友"));
  assert.ok(!all.includes("你的查验记录"));
  assert.ok(!all.includes("你的解药"));
  assert.ok(!all.includes("刀口是"));
});

test("夜晚阶段角色强一致：狼/预/女阶段配错角色直接抛错", () => {
  assert.throws(() => buildMessages([], { seat: 3, role: "villager" }, "wolf"), /prompts:/);
  assert.throws(() => buildMessages([], { seat: 9, role: "witch" }, "seer"), /prompts:/);
  assert.throws(() => buildMessages([], { seat: 3, role: "seer" }, "witch"), /prompts:/);
});

test("狼人定刀：队友按身份卡渲染且不含自己；夜晚序号 = 最大 day + 1", () => {
  const card = { seat: 6, role: "wolf", wolves: [2, 5, 6] };
  const msgs = buildMessages(sampleHistory(), card, "wolf");
  const all = msgs[0].content + msgs[1].content;
  assert.ok(all.includes("全体狼座位：2、5、6 号"));
  assert.ok(all.includes("狼队友已全部出局，只剩你")); /* 2、5 均已死，6 是自己 */
  assert.ok(msgs[1].content.includes("第3夜")); /* 最大 day=2 → 当前是第 3 夜 */
  assert.ok(msgs[1].content.includes("不可空刀") || msgs[0].content.includes("不可空刀"));
});

test("预言家：验史渲染 + 夜晚任务提示", () => {
  const card = {
    seat: 3, role: "seer",
    checks: [{ night: 1, seat: 4, result: "good" }, { night: 2, seat: 7, result: "wolf" }]
  };
  const msgs = buildMessages(sampleHistory(), card, "seer");
  const all = msgs[0].content + msgs[1].content;
  assert.ok(all.includes("第1夜验4号 → 好人"));
  assert.ok(all.includes("第2夜验7号 → 狼人"));
  assert.ok(msgs[1].content.includes("不可验自己"));
});

test("女巫：双药 + 刀口可见 → save/座位号/skip；解药耗尽 → 不再显示刀口", () => {
  const a = buildMessages(sampleHistory(), Object.assign(witchCard(), { knifeTarget: 2 }), "witch");
  assert.ok(a[1].content.includes("当夜刀口是 2 号"));
  assert.ok(a[1].content.includes("save"));
  assert.ok(a[1].content.includes("第3夜"));

  const b = buildMessages(sampleHistory(), { seat: 9, role: "witch", antidote: false, poison: true }, "witch");
  assert.ok(!b[1].content.includes("刀口是"));
  assert.ok(b[1].content.includes("解药已用完"));
  assert.ok(!b[1].content.includes("save")); /* 没解药就不给 save 选项 */

  const c = buildMessages(sampleHistory(), { seat: 9, role: "witch", antidote: true, poison: false, knifeTarget: 2 }, "witch");
  assert.ok(c[1].content.includes("毒药已用完"));
  assert.ok(c[1].content.includes("当夜刀口是"));
  assert.ok(!c[1].content.includes("毒药毒"));
});

test("女巫自救口径：首夜刀口是自己可救；非首夜提示禁止自救（§4.1.3）", () => {
  const first = buildMessages([], Object.assign(witchCard(), { knifeTarget: 9 }), "witch");
  assert.ok(first[1].content.includes("首夜"));
  assert.ok(first[1].content.includes("自救"));

  const later = buildMessages(sampleHistory(), Object.assign(witchCard(), { knifeTarget: 9 }), "witch");
  assert.ok(later[1].content.includes("禁止自救"));
});

test("九个阶段全部可组装；遗言/开枪阶段标注出局", () => {
  const cards = {
    wolf: { seat: 6, role: "wolf", wolves: [2, 5, 6] },
    villager: { seat: 3, role: "villager" },
    seer: { seat: 3, role: "seer", checks: [] },
    witch: witchCard()
  };
  for (const phase of PHASES) {
    const role = phase === "wolf" ? "wolf" : phase === "seer" ? "seer" : phase === "witch" ? "witch" : "villager";
    const msgs = buildMessages(sampleHistory(), cards[role], phase);
    assert.equal(msgs.length, 2, phase + " 组装失败");
    assert.ok(msgs[1].content.includes("【当前任务】"), phase + " 缺任务提示");
  }
  const lw = buildMessages(sampleHistory(), cards.villager, "lastwords");
  assert.ok(lw[1].content.includes("你已出局"));
  assert.ok(lw[1].content.includes("禁止弃权"), "遗言任务须禁弃权（防「先过，看看后面发言再说」式敷衍）");
  assert.ok(lw[1].content.includes("首夜就被杀"), "遗言任务须含首夜死基础信息指引");
  const hu = buildMessages(sampleHistory(), cards.villager, "hunter");
  assert.ok(hu[1].content.includes("翻牌开枪"));
});

test("每座位口吻确定性轮换（同座位两次组装一致，不同座位不同）", () => {
  const a1 = buildMessages([], { seat: 1, role: "villager" }, "speak")[0].content;
  const a2 = buildMessages([], { seat: 1, role: "villager" }, "speak")[0].content;
  const b = buildMessages([], { seat: 2, role: "villager" }, "speak")[0].content;
  assert.ok(a1.includes("【你的口吻】"));
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("非法输入抛错（调用方按 features.md §8.4 走确定性回退）", () => {
  assert.throws(() => buildMessages([], { seat: 0, role: "villager" }, "speak"), /prompts:/);
  assert.throws(() => buildMessages([], { seat: 3, role: "god" }, "speak"), /prompts:/);
  assert.throws(() => buildMessages([], { seat: 3, role: "villager" }, "fly"), /prompts:/);
  assert.throws(() => buildMessages("no", { seat: 3, role: "villager" }, "speak"), /prompts:/);
  assert.throws(() => buildMessages([{ t: "boom", day: 1 }], { seat: 3, role: "villager" }, "speak"), /prompts:/);
  assert.throws(
    () => buildMessages([{ t: "speech", day: 1, seat: 0, text: "x" }], { seat: 3, role: "villager" }, "speak"),
    /prompts:/
  );
  assert.throws(() => buildMessages([], { seat: 3, role: "wolf", wolves: [] }, "wolf"), /prompts:/);
  assert.throws(
    () => buildMessages([], { seat: 9, role: "witch", antidote: true, poison: true, knifeTarget: 12 }, "witch"),
    /prompts:/
  );
});

test("发言任务含长度约束；投票任务只允许座位号或 skip", () => {
  const sp = buildMessages(sampleHistory(), { seat: 3, role: "villager" }, "speak")[1].content;
  assert.ok(sp.includes("100–200 字"));
  const vt = buildMessages(sampleHistory(), { seat: 3, role: "villager" }, "vote")[1].content;
  assert.ok(vt.includes("座位号数字，或 skip"));
});
