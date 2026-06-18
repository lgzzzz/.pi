/**
 * 历史扩展 — 共享常量
 *
 * 整个历史查看器组件使用的所有魔数、ANSI 转义序列和配置值。
 */

/** 每次按上/下箭头滚动的行数。 */
export const SCROLL_LINE_STEP = 1;

/**
 * ANSI 转义序列：进入备用屏幕。
 * 合并为单次写入以避免闪烁。
 */
export const ALT_SCREEN_ENTER = [
  "\x1b[?1049h", // 进入备用屏幕
  "\x1b[?1006h", // 启用 SGR 鼠标模式
  "\x1b[?25l",   // 隐藏光标
  "\x1b[2J\x1b[H",
].join("");

/**
 * ANSI 转义序列：退出备用屏幕并恢复终端状态。
 * 合并为单次写入以避免闪烁。
 */
export const ALT_SCREEN_EXIT = [
  "\x1b[?1049l",   // 进入主屏幕
  "\x1b[?1006l",   // 禁用 SGR 鼠标模式
  "\x1b[?25h",     // 显示光标
  "\x1b[2J\x1b[H",
].join("");

/** 使用 pi 原生 ToolExecutionComponent 进行富文本渲染的内置工具名称集合。 */
export const BUILT_IN_TOOL_NAMES = new Set(["read", "edit", "write", "bash"]);

/** 旋转动画帧，与 pi 内置 Loader 的默认帧保持一致。 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 旋转帧间隔（毫秒），与 pi 内置 Loader 的默认间隔保持一致。 */
export const SPINNER_INTERVAL_MS = 80;
