/**
 * 历史扩展 — 主题访问
 *
 * 提供对 pi 主题对象的类型化访问，该对象通过
 * 众所周知的 Symbol 键存储在 globalThis 上。
 */

/** pi 用于将主题对象存储在 globalThis 上的 Symbol 键。 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** 提供带样式文本格式的最小主题接口。 */
export interface Theme {
    fg(color: string, text: string): string;
    bold(text: string): string;
    italic(text: string): string;
}

/**
 * 返回当前的 pi 主题实例。
 * 主题由 pi 在初始化期间设置在 globalThis 上。
 */
export function getTheme(): Theme {
    return (globalThis as Record<symbol, unknown>)[THEME_KEY] as Theme;
}
