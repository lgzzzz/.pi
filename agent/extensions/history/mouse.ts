/**
 * 历史扩展 — 鼠标事件处理
 *
 * 解析终端在备用屏幕模式下生成的
 * SGR（Send Graphics Rendition）鼠标转义序列。
 */

import { SCROLL_LINE_STEP, MOUSE_WHEEL_UP, MOUSE_WHEEL_DOWN, SGR_MOUSE_PATTERN } from "./constants.js";

/**
 * 解析 SGR 鼠标转义序列并返回滚动增量。
 *
 * SGR 格式：
 *   \x1b[<按钮;列;行M  （按下）
 *   \x1b[<按钮;列;行m  （释放）
 *
 * 对于滚轮向下返回 SCROLL_LINE_STEP（正数），
 * 对于滚轮向上返回 -SCROLL_LINE_STEP（负数），
 * 对于其他事件返回 0。
 */
export function parseSGRMouseScroll(data: string): number {
    const match = data.match(SGR_MOUSE_PATTERN);
    if (!match) return 0;

    const button = parseInt(match[1], 10);
    if (button === MOUSE_WHEEL_UP)   return -SCROLL_LINE_STEP;
    if (button === MOUSE_WHEEL_DOWN) return SCROLL_LINE_STEP;
    return 0;
}
