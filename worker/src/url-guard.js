/* ============================================================
 * worker/src/url-guard.js —— 服务端出站 URL 校验（SSRF 防护）
 * ------------------------------------------------------------
 * 规则唯一来源：docs/features.md §10 与 docs/reference-situation-puzzle.md
 * 第三节（母本口径全量照抄，硬性验收条件，永不简化）：
 *   1. 仅允许 http / https；
 *   2. 拒绝 URL 内嵌账密（user:pass@host）；
 *   3. 拒绝 localhost（含 *.localhost）与 .local / .internal /
 *      .intranet / .lan / .home / .arpa 后缀主机名；
 *   4. 拒绝环回 / 私网 / 链路本地 / 保留 IPv4 段：
 *      0/8、10/8、127/8、169.254/16、172.16-31、192.168/16、
 *      100.64/10、192.0.x、198.18-19、≥224（组播与保留，含 255）；
 *   5. 拒绝 IPv6 ::（未指定）、::1（环回）及 fc / fd / fe / ff 前缀，
 *      以及内嵌 IPv4 映射地址（如 ::ffff:127.0.0.1）中的保留 IPv4。
 * 纯函数：checkUrl(u) → null = 合放行 / 字符串 = 拒绝原因。
 * 一切服务端出站 fetch（ai-proxy、DO 内 AI 调用）调用前必须过本函数。
 *
 * ponytail: 已知天花板——本函数只做字面校验，不解析 DNS；公网域名被
 * rebind 到私网 IP 的绕过需出站后复核对端 IP，属第二版升级路径
 * （母本同样接受此限制）。URL 规范允许的 IPv4 变体写法
 * （127.1、0x7f.1、2130706433）已按「宽容解析再判段」覆盖。
 * ============================================================ */

const BAD_HOST_SUFFIXES = ['.local', '.internal', '.intranet', '.lan', '.home', '.arpa'];

/** 按第一 / 二字节判定是否落在保留 IPv4 段（features.md §10 全量清单）。 */
function badIPv4Bytes(a, b) {
  if (a === 0 || a === 10 || a === 127) return true; // 0/8、10/8、127/8
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
  if (a === 192 && b === 168) return true; // 192.168/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.x 保留（TEST-NET 等）
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a >= 224) return true; // ≥224 组播与保留（含 255.255.255.255）
  return false;
}

/**
 * 宽容解析点分 IPv4 字面量 → 32 位无符号数；不是 IPv4 形状则返回 null。
 * 覆盖 4 段、3 段（127.1）、十六进制段（0x7f.1）与纯整数（2130706433）。
 */
function parseIPv4(host) {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  let val = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    let n;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part, 16);
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    if (isLast) {
      // 末段可占多字节：127.1 → 0x7F000001；单段即整个 32 位地址
      const bytes = 4 - (parts.length - 1);
      if (n >= 256 ** bytes) return null;
      val = val * 256 ** bytes + n;
    } else {
      if (n > 255) return null;
      val = val * 256 + n;
    }
  }
  return val >>> 0;
}

/** IPv6 校验：::、::1、fc/fd/fe/ff 前缀、内嵌 IPv4 映射（含规范化十六进制形）。 */
function ipv6Reject(host0) {
  /* Node/WHATWG 的 hostname 保留方括号（母本同款手动剥掉）；统一小写 */
  let host = host0;
  if (host.charAt(0) === '[') host = host.slice(1, host.length - 1);
  host = host.toLowerCase();
  if (host === '::') return 'IPv6 未指定地址 ::';
  if (host === '::1') return 'IPv6 环回地址 ::1';
  /* 内嵌 IPv4：
   *  a) 点分尾段（::ffff:127.0.0.1，浏览器侧常见）；
   *  b) URL 规范化后的十六进制映射（node 把 ::ffff:127.0.0.1 变 ::ffff:7f00:1，
   *     末两组 hextet 即 IPv4 四字节）。均按保留 IPv4 段判。 */
  const tail = host.slice(host.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 !== null && badIPv4Bytes(v4 >>> 24, (v4 >>> 16) & 255)) {
      return `IPv6 内嵌保留 IPv4 ${host}`;
    }
    return null;
  }
  if (host.startsWith('::')) {
    /* IPv4 映射 / 兼容形：::ffff:7f00:1（规范化三组）或 ::7f00:1（两组），末两组即 IPv4 字节 */
    const m = host.slice(2).match(/^(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[1], 16);
      if (badIPv4Bytes(hi >>> 8, hi & 255)) return `IPv6 内嵌保留 IPv4 ${host}`;
    }
  }
  /* 首个 hextet 的最高字节落在 fc/fd/fe/ff（fc00::/7 ULA、fe80::/10 链路本地、ff00::/8 组播） */
  const head = host.split(':')[0];
  if (head === '') return null; // 其余 '::x' 罕见形式不在拒绝清单
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  const first = parseInt(head, 16);
  if ((first >>> 8) >= 0xfc) return `IPv6 保留前缀 ${host}`;
  return null;
}

/**
 * 校验出站 URL。null = 放行；字符串 = 拒绝原因。
 * 用例基线（features.md §10）：拒 http://localhost、http://127.0.0.1、
 * http://192.168.1.1、http://10.0.0.1、https://[::1]/、ftp://…、
 * http://user:pass@host；放行 https://api.openai.com。
 */
export function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'URL 为空';
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return 'URL 无法解析';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `协议仅允许 http/https（当前 ${u.protocol}）`;
  }
  if (u.username !== '' || u.password !== '') return 'URL 内嵌账密';
  const host = u.hostname.toLowerCase();
  if (!host) return '缺少主机名';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost 主机';
  for (const suf of BAD_HOST_SUFFIXES) {
    if (host.endsWith(suf)) return `保留主机名后缀 ${suf}`;
  }
  const v4 = parseIPv4(host);
  if (v4 !== null) {
    if (badIPv4Bytes(v4 >>> 24, (v4 >>> 16) & 255)) return `保留 IPv4 段 ${host}`;
    return null;
  }
  if (host.includes(':')) {
    const reason = ipv6Reject(host);
    if (reason) return reason;
  }
  return null;
}

/**
 * 出站 fetch 专用净化出口：唯一合法的取目标 URL 方式。
 * 返回 { ok: true, url } （url 为校验通过的规范化地址）或 { ok: false, reason }。
 * 调用方必须以本函数返回的 url 作为 fetch 目标，禁止直接 fetch 原始输入
 * ——让校验结果与出站目标在数据流上强绑定（SSRF 防护，features.md §10）。
 */
export function safeOutboundUrl(raw) {
  const reason = checkUrl(raw);
  if (reason !== null) return { ok: false, reason };
  return { ok: true, url: new URL(raw).toString() };
}
