/* ============================================================
 * worker/src/do-rpc.js —— Durable Object 内部 RPC 统一入口
 * ------------------------------------------------------------
 * Cloudflare 的 DO 调用机制只有 stub.fetch() 一种（官方 API）。
 * 这里的 stub 是命名空间绑定（env.ROOM.get(id)）返回的对象，
 * 流量不出 Cloudflare 网络边界，不存在 SSRF 面（母本同款收口，
 * situation_puzzle worker/src/do-rpc.js 照抄）。
 * 【约束】workerd 的 Request 构造器只收绝对 URL（相对路径同步抛
 * "Invalid URL"）；本函数对字符串统一补 https://do 假主机兜底，
 * DO fetch 只解析 path+query，假主机名不出网。
 * roomStub 一并收口在本文件：房号 → DO 实例的映射（idFromName，
 * 转大写归一），路由层不直接触碰命名空间绑定。
 * ============================================================ */

export function roomStub(env, code) {
  return env.ROOM.get(env.ROOM.idFromName(String(code).toUpperCase()));
}

export function doRpc(stub, url, init) {
  let target = url;
  if (typeof target === 'string' && !/^https?:\/\//i.test(target)) {
    target = 'https://do' + (target.charAt(0) === '/' ? target : '/' + target);
  }
  return stub.fetch(target, init);
}
