/**
 * 消息处理工具
 *
 * 从 subagent/index.ts 中提取，提供从 pi 消息流中读取结构化输出的通用函数。
 */

import type { Message } from "@earendil-works/pi-ai";
import type { UsageStats } from "./tokens.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type { UsageStats } from "./tokens.js";

export interface SingleResult {
    agent: string;
    agentSource: "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
}

export type DisplayItem =
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; args: Record<string, any> };

// ---------------------------------------------------------------------------
// 消息内容提取
// ---------------------------------------------------------------------------

/**
 * 从消息列表中提取最后一条 assistant 消息的文本内容。
 */
export function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

/**
 * 将消息列表转换为可展示的项（文本 + tool call）。
 */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
    const items: DisplayItem[] = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text")
                    items.push({ type: "text", text: part.text });
                else if (part.type === "toolCall")
                    items.push({
                        type: "toolCall",
                        name: part.name,
                        args: part.arguments,
                    });
            }
        }
    }
    return items;
}

// ---------------------------------------------------------------------------
// 结果判断
// ---------------------------------------------------------------------------

/** 判断子代理执行结果是否为失败状态 */
export function isFailedResult(result: SingleResult): boolean {
    return (
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted"
    );
}

/** 从结果中获取有效的输出文本（失败时回退到错误信息） */
export function getResultOutput(result: SingleResult): string {
    if (isFailedResult(result)) {
        return (
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(no output)"
        );
    }
    return getFinalOutput(result.messages) || "(no output)";
}
