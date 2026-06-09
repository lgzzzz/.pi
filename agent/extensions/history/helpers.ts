/**
 * 历史扩展 — 工具辅助函数
 *
 * 历史查看器组件和事件处理器中使用的
 * 共享格式化、内容提取和类型守卫函数。
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
    createReadToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Usage 聚合
// ---------------------------------------------------------------------------

/** 从 session entries 聚合得到的 usage 统计。 */
export interface UsageTotals {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
}

/**
 * 从 session entries 列表中聚合所有 assistant 消息的 usage 统计。
 *
 * 用法：提供给 buildFooterLines 或任何需要展示 token 统计的位置使用。
 */
export function aggregateUsage(
    entries: ReadonlyArray<{
        type: string;
        message?: {
            role: string;
            usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        };
    }>,
): UsageTotals {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    for (const entry of entries) {
        if (entry.type === "message" && entry.message?.role === "assistant") {
            const usage = entry.message.usage;
            if (usage) {
                totalInput += usage.input ?? 0;
                totalOutput += usage.output ?? 0;
                totalCacheRead += usage.cacheRead ?? 0;
                totalCacheWrite += usage.cacheWrite ?? 0;
            }
        }
    }
    return { totalInput, totalOutput, totalCacheRead, totalCacheWrite };
}

// ---------------------------------------------------------------------------
// 内容提取
// ---------------------------------------------------------------------------

/**
 * 从消息的 content 字段中提取面向用户的文本。
 *
 * 同时处理字符串内容和内容数组格式。
 * 内容数组中的图像被替换为 "[Image]" 占位符。
 */
export function extractUserMessageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
        .map((item) => {
            if (isTextContent(item)) return item.text;
            return "[Image]";
        })
        .join("\n");
}

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

/** 若该值是 pi TextContent 对象则返回 true。 */
export function isTextContent(value: unknown): value is TextContent {
    return (
        typeof value === "object" &&
        value !== null &&
        "text" in (value as Record<string, unknown>)
    );
}

// ---------------------------------------------------------------------------
// 工具定义工厂
// ---------------------------------------------------------------------------

/**
 * 返回一个 pi 内置工具定义，仅用于渲染。
 *
 * 内置工具（read/edit/write/bash）使用 pi 的原生 ToolExecutionComponent
 * 进行富文本 diff/代码高亮渲染。此工厂提供匹配的定义，
 * 使渲染器能够生成带样式的输出。
 */
export function createBuiltInToolDefinition(name: string, cwd: string): ToolDefinition<any, any> | undefined {
    switch (name) {
        case "read":  return createReadToolDefinition(cwd);
        case "edit":  return createEditToolDefinition(cwd);
        case "write": return createWriteToolDefinition(cwd);
        case "bash":  return createBashToolDefinition(cwd);
        default:      return undefined;
    }
}

// ---------------------------------------------------------------------------
// 折叠预览构建
// ---------------------------------------------------------------------------

/**
 * 构建工具结果的折叠预览字符串。
 *
 * 若内容行数未超过 maxLines，则返回所有行（每条用 toolOutput 颜色着色）。
 * 若超过，则仅返回前 maxLines 行 + muted 颜色的展开提示行。
 *
 * @param text          要预览的原始文本内容
 * @param maxLines      预览模式下显示的最大行数
 * @param fg            前景色着色函数，如 theme.fg
 * @param expandHint    展开提示文本（如 keyHint 输出），若为空则不追加提示
 * @returns             可渲染的 ANSI 字符串
 */
export function buildCollapsedToolPreview(
    text: string,
    maxLines: number,
    fg: (color: string, s: string) => string,
    expandHint: string,
): string {
    const lines = text.split("\n");
    if (lines.length <= maxLines) {
        return lines.map((l) => fg("toolOutput", l)).join("\n");
    }

    const preview = lines
        .slice(0, maxLines)
        .map((l) => fg("toolOutput", l))
        .join("\n");

    if (!expandHint) return preview;
    return `${preview}\n${fg("muted", expandHint)}`;
}
