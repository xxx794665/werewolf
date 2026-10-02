/* ============================================================
 * js/icons.js —— SVG 图标库（全站零 emoji 的唯一图标来源，features.md §1）
 * ------------------------------------------------------------
 * 用法：
 *   import { icon } from "./icons.js";
 *   el.innerHTML = icon("wolf");            // 图标是本模块常量，可信，可 innerHTML
 *   span.append(iconEl("moon"));            // 或拿 DOM 节点（ui.js 用）
 * 约定：全部 24×24 viewBox、stroke="currentColor"，颜色与字号随上下文
 *   （CSS .icon 控制尺寸，见 style.css）。新增图标只加 ICONS 一项。
 *   改本文件后 sw.js CACHE +1（CLAUDE.md 硬规则）。
 * ============================================================ */

const OPEN =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

export const ICONS = {
  /* 狼人：尖耳狼头 */
  wolf:
    OPEN +
    '<path d="M5 10 4 3.5 9 7h6l5-3.5L19 10"/>' +
    '<path d="M5 10c0 5 2.6 9 7 9s7-4 7-9"/>' +
    '<circle cx="9.2" cy="11.5" r="0.4" fill="currentColor"/>' +
    '<circle cx="14.8" cy="11.5" r="0.4" fill="currentColor"/>' +
    '<path d="M10.5 15.5h3L12 17.8z" fill="currentColor" stroke="none"/></svg>',
  /* 平民：人形 */
  villager:
    OPEN +
    '<circle cx="12" cy="8" r="3.4"/>' +
    '<path d="M5.5 20c.8-3.6 3.4-5.4 6.5-5.4s5.7 1.8 6.5 5.4"/></svg>',
  /* 预言家：眼睛 */
  seer:
    OPEN +
    '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/>' +
    '<circle cx="12" cy="12" r="2.6"/></svg>',
  /* 女巫：药瓶 */
  witch:
    OPEN +
    '<path d="M10 3h4M11 3v4.2L6.3 15a3.6 3.6 0 0 0 3.2 5.4h5a3.6 3.6 0 0 0 3.2-5.4L13 7.2V3"/>' +
    '<path d="M8.2 13.5h7.6"/></svg>',
  /* 猎人：准星 */
  hunter:
    OPEN +
    '<circle cx="12" cy="12" r="6.5"/>' +
    '<path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>' +
    '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>',
  /* 死亡：骷髅 */
  skull:
    OPEN +
    '<path d="M12 3.5a7 7 0 0 0-7 7c0 2.6 1.4 4.4 3 5.4V19a1.6 1.6 0 0 0 1.6 1.6h4.8A1.6 1.6 0 0 0 16 19v-3.1c1.6-1 3-2.8 3-5.4a7 7 0 0 0-7-7Z"/>' +
    '<circle cx="9.3" cy="11" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="14.7" cy="11" r="1.2" fill="currentColor" stroke="none"/>' +
    '<path d="M10.8 20.6v-2M13.2 20.6v-2"/></svg>',
  /* 房主：皇冠 */
  crown: OPEN + '<path d="M4 17.5 3 7l5 3.8L12 5l4 5.8L21 7l-1 10.5z"/><path d="M5.5 20.5h13"/></svg>',
  /* AI 座位：机器人 */
  robot:
    OPEN +
    '<rect x="5" y="8.5" width="14" height="10" rx="2.2"/>' +
    '<path d="M12 8.5V5M12 5h3"/>' +
    '<circle cx="9.3" cy="13" r="0.5" fill="currentColor"/>' +
    '<circle cx="14.7" cy="13" r="0.5" fill="currentColor"/>' +
    '<path d="M9.5 16.5h5"/></svg>',
  /* 已准备 / 确认：对勾 */
  check: OPEN + '<path d="m4.5 12.5 5 5 10-11"/></svg>',
  /* 夜：月牙 */
  moon: OPEN + '<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/></svg>',
  /* 昼：太阳 */
  sun:
    OPEN +
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></svg>',
  /* 设置：齿轮 */
  gear:
    OPEN +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8"/></svg>',
  /* 返回：左箭头 */
  back: OPEN + '<path d="M15 5l-7 7 7 7"/></svg>',
  /* 复制房号 */
  copy:
    OPEN +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/></svg>',
};

/** 图标 SVG 字符串（可信常量，可 innerHTML）。未知名字退化为空心圆点占位。 */
export function icon(name) {
  return ICONS[name] || OPEN + '<circle cx="12" cy="12" r="3"/></svg>';
}

/** 图标 DOM 节点版（ui.js 用 createElement 路线时调用，避免拼 innerHTML）。 */
export function iconEl(name) {
  const span = document.createElement("span");
  span.className = "icon-wrap";
  span.innerHTML = icon(name); // 常量，非用户输入
  return span;
}
