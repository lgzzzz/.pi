/**
 * Custom Footer Extension
 *
 * 替换 pi 原生 footer，功能与原生一致，改动：
 * 1. 费用从美元改为人民币（¥），DeepSeek v4 pro 定价：
 *    - 输入未命中缓存：2 元/百万 tokens
 *    - 输入命中缓存：0.025 元/百万 tokens
 *    - 输出：6 元/百万 tokens
 * 2. 缓存命中率改为整个 session 的 ∑cacheRead / (∑input + ∑cacheRead)
 * 3. buildFooterLines 可从其他扩展 import 复用
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildFooterLines } from "./buildFooterLines.js";

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;

        ctx.ui.setFooter((tui, theme, footerData) => {
            // git branch 变化时重新渲染
            const unsub = footerData.onBranchChange(() =>
                tui.requestRender(),
            );

            return {
                dispose: unsub,
                invalidate() {
                    // 主题变化时由 pi 自动调用
                },
                render(width: number): string[] {
                    // ── 聚合所有 assistant 消息的 usage ────────────
                    let totalInput = 0;
                    let totalOutput = 0;
                    let totalCacheRead = 0;
                    let totalCacheWrite = 0;

                    for (const entry of ctx.sessionManager.getEntries()) {
                        if (
                            entry.type === "message" &&
                            entry.message.role === "assistant"
                        ) {
                            const usage = entry.message.usage;
                            totalInput += usage.input;
                            totalOutput += usage.output;
                            totalCacheRead += usage.cacheRead;
                            totalCacheWrite += usage.cacheWrite;
                        }
                    }

                    // ── 上下文使用 ──────────────────────────────────
                    const contextUsage = ctx.getContextUsage();
                    const contextWindow =
                        contextUsage?.contextWindow ??
                        ctx.model?.contextWindow ??
                        0;
                    const contextTokens =
                        contextUsage?.tokens ?? null;

                    // ── 模型信息 ────────────────────────────────────
                    const model = ctx.model;
                    const modelName = model?.id ?? "no-model";
                    const provider = model?.provider;
                    const providerCount =
                        footerData.getAvailableProviderCount();
                    const modelReasoning = model?.reasoning ?? false;
                    const thinkingLevel = pi.getThinkingLevel();

                    // ── 订阅检测 ────────────────────────────────────
                    const usingSubscription = model
                        ? ctx.modelRegistry?.isUsingOAuth?.(model) ?? false
                        : false;

                    // ── session 名称 ───────────────────────────────
                    const sessionName =
                        ctx.sessionManager.getSessionName() ?? undefined;

                    // ── 调用可复用函数 ─────────────────────────────
                    return buildFooterLines({
                        width,
                        cwd: ctx.cwd,
                        home: process.env.HOME || process.env.USERPROFILE,
                        gitBranch: footerData.getGitBranch() ?? undefined,
                        sessionName,
                        totalInput,
                        totalOutput,
                        totalCacheRead,
                        totalCacheWrite,
                        usingSubscription,
                        contextTokens,
                        contextWindow,
                        modelName,
                        provider,
                        providerCount,
                        modelReasoning,
                        thinkingLevel,
                        fg: (color, text) => theme.fg(color, text),
                    });
                },
            };
        });
    });

    // 模型或 thinking level 变化时请求重新渲染
    pi.on("model_select", () => {
        // footer 在下次 render 时会自动反映新的 ctx.model
    });
    pi.on("thinking_level_select", () => {
        // footer 在下次 render 时会自动反映新的 thinking level
    });
}
