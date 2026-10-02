/* ============================================================
 * worker/src/rate-limit.js —— 建房限流（同 IP 每日计数）
 * ------------------------------------------------------------
 * isolate 内存 Map，重启清零（母本同款已知限制，README 引用）。
 * 本文件不出现 Request 对象：ip 由调用方（worker/src/index.js 路由）
 * 传入，计数逻辑保持纯函数可测。
 * 上限 100 房 / 日（features.md §9：单机每局都建房，限额低于 100
 * 会卡死重度玩家）。
 * ============================================================ */

const NEW_ROOM_DAILY = 100;
const newRoomCounts = new Map();

function dayKey(now) {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** 计数并判断：返回 true = 本 IP 今日建房已超限（拒绝）。 */
export function newRoomLimited(ip, now) {
  const day = dayKey(now);
  let rec = newRoomCounts.get(ip);
  if (!rec || rec.day !== day) {
    rec = { day, count: 0 };
    newRoomCounts.set(ip, rec);
  }
  rec.count += 1;
  return rec.count > NEW_ROOM_DAILY;
}

/** 仅测试用：清空建房计数。 */
export function resetRoomLimiterForTests() {
  newRoomCounts.clear();
}
