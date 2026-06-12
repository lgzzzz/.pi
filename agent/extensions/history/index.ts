/**
 * 历史扩展
 *
 * 显示当前轮次所有消息的可滚动历史视图。
 * 通过 Ctrl+H 在备用屏幕中打开，按 ESC 关闭。
 *
 * 功能：
 *   - 渲染用户消息、助手消息以及工具调用/结果
 *   - 使用箭头键滚动（上下 1 行，左右整页增量）
 *   - 所有工具（内置 read/edit/write/bash 及 junie_ai 等）统一使用 pi 的原生
 *     ToolExecutionComponent 进行富文本 diff/代码渲染
 *   - Ctrl+O 同时切换所有工具结果的展开/折叠状态
 *   - Agent 工作时在内容底部显示旋转 working 指示器，与 pi 内置 Loader 一致
 *
 * 目录结构：
 *   index.ts               — 扩展入口（事件处理器 + 覆盖层逻辑）
 *   constants.ts           — 共享常量（魔数、ANSI 序列、旋转帧）
 *   theme.ts               — 主题访问辅助函数
 *   helpers.ts             — 格式化、内容提取、工具定义工厂

 *   HistoryViewer.ts       — 可滚动视口控制器（渲染 + 输入处理）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    UserMessageComponent,
    AssistantMessageComponent,
    getMarkdownTheme,
    ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
    BUILT_IN_TOOL_NAMES,
    ALT_SCREEN_ENTER,
    ALT_SCREEN_EXIT,
} from "./constants.js";
import { extractUserMessageText, createBuiltInToolDefinition, aggregateUsage } from "./helpers.js";
import { createJunieAiToolDefinition } from "../junie.js";
import { createSubagentToolDefinition } from "../subagent/tool-definition.js";
import { HistoryViewer } from "./HistoryViewer.js";
import { loadConfig } from "./config.js";
import { buildFooterLines } from "../custom-footer/buildFooterLines.js";
import { getTheme } from "./theme.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 类型别名
// ---------------------------------------------------------------------------

/** 将 toolCallId 映射到对应的渲染组件。 */
type ToolRegistry = Map<string, ToolExecutionComponent>;

// ---------------------------------------------------------------------------
// 扩展工厂
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

    // -- 每轮次的状态 --------------------------------------------------------

    /** 当前轮次中显示的组件（消息 + 工具调用）。 */
    let messageComponents: Component[] = [];

    /** 工具调用组件注册表，以 toolCallId 为键。 */
    let toolRegistry: ToolRegistry = new Map();

    /** 当前正在流式输出的助手消息组件（如果有）。 */
    let streamingAssistant: AssistantMessageComponent | null = null;

    /** 备用屏幕 TUI 的引用，在覆盖层打开时设置。 */
    let overlayTui: TUI | null = null;

    /** 当前工作目录，在 agent_start 时设置。 */
    let workingDir: string = "";

    /** 历史查看器覆盖层当前是否已打开。 */
    let viewerOpen: boolean = false;

    /** Agent 是否正在工作中（agent_start 到 agent_end 之间）。 */
    let isWorking: boolean = false;

    /** 当前扩展上下文（在 agent_start 时捕获，供 footer 渲染使用）。 */
    let currentCtx: ExtensionContext | null = null;

    // 缓存的 markdown 主题 — 在所有组件中复用
    const markdownTheme = getMarkdownTheme();

    // -- 工具函数 ------------------------------------------------------------

    /** 若存在覆盖层 TUI，则请求其重新渲染。 */
    function requestRender(): void {
        overlayTui?.requestRender();
    }

    /**
     * 返回一个委托给 overlayTui 的最小 TUI 包装器。
     *
     * ToolExecutionComponent 使用它来在流式输出期间触发重新渲染。
     * 不能传 `undefined`，因为它期望一个带有 requestRender 方法的
     * 类 TUI 对象。
     */
    function createTuiWrapper(): TUI {
        return { requestRender: () => overlayTui?.requestRender() } as TUI;
    }

    /** 为新的代理轮次重置所有轮次状态。 */
    function resetTurnState(cwd: string): void {
        messageComponents = [];
        toolRegistry = new Map();
        streamingAssistant = null;
        overlayTui = null;
        workingDir = cwd;
    }

    /**
     * 返回当前 working 状态快照，供 HistoryViewer 轮询。
     * 返回新对象以避免引用问题。
     */
    function getWorkingStatus(): { isWorking: boolean } {
        return { isWorking };
    }

    // -- 覆盖层管理 ----------------------------------------------------------

    /** 在备用屏幕中以全屏覆盖层的形式打开历史查看器。 */
    function openHistoryView(ctx: { ui: { custom: Function }; mode?: string; hasUI?: boolean }): void {
        // 仅在 TUI 模式下可用
        if (ctx.mode !== undefined && ctx.mode !== "tui") return;
        if (ctx.hasUI === false) return;

        // 如果已经打开，不要重复打开
        if (viewerOpen) return;
        viewerOpen = true;

        // 在打开查看器时获取一次 git 分支，避免每次渲染都执行 git 命令
        const cachedGitBranch: string | undefined = (() => {
            if (!currentCtx) return undefined;
            try {
                return execSync("git branch --show-current", {
                    cwd: currentCtx.cwd,
                    encoding: "utf-8",
                    timeout: 1000,
                    stdio: ["pipe", "pipe", "pipe"],
                }).trim() || undefined;
            } catch {
                // 非 git 仓库或命令失败，忽略
                return undefined;
            }
        })();

        /** 构建自定义 footer 行（在渲染时动态计算）。 */
        const getFooterLines = (width: number) => {
            const c = currentCtx;
            if (!c) return [] as string[];

            // 聚合所有 assistant 消息的 usage
            const { totalInput, totalOutput, totalCacheRead, totalCacheWrite } =
                aggregateUsage(c.sessionManager.getEntries());

            const contextUsage = c.getContextUsage();
            const contextWindow =
                contextUsage?.contextWindow ??
                c.model?.contextWindow ??
                0;
            const contextTokens = contextUsage?.tokens ?? null;

            const model = c.model;
            const modelName = model?.id ?? "no-model";
            const provider = model?.provider;
            const modelReasoning = model?.reasoning ?? false;
            const thinkingLevel = pi.getThinkingLevel();
            const usingSubscription = model
                ? c.modelRegistry?.isUsingOAuth?.(model) ?? false
                : false;
            const sessionName =
                c.sessionManager.getSessionName() ?? undefined;

            const theme = getTheme();
            return buildFooterLines({
                width,
                cwd: c.cwd,
                home: process.env.HOME || process.env.USERPROFILE,
                gitBranch: cachedGitBranch,
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
                modelReasoning,
                thinkingLevel,
                fg: (color, text) => theme.fg(color, text),
            });
        };

        const viewer = new HistoryViewer(
            () => messageComponents,
            getWorkingStatus,
            getFooterLines,
        );

        ctx.ui.custom(
            (
                tui: TUI,
                _theme: unknown,
                _kb: unknown,
                done: (result?: unknown) => void,
            ) => {
                overlayTui = tui;
                viewer.setTui(tui);
                const terminal = tui.terminal;

                // 进入备用屏幕
                terminal.write(ALT_SCREEN_ENTER);

                // 在空白备用屏幕上强制进行全量渲染
                tui.requestRender(true);

                return {
                    render: (width: number) => viewer.render(width, tui.terminal.rows),

                    handleInput: (data: string) => {
                        // ESC：关闭覆盖层并返回主屏幕
                        if (matchesKey(data, Key.esc)) {
                            closeViewer();
                            return;
                        }

                        // Ctrl+C：传递到底层终端以支持复制快捷键（不做任何操作）
                        if (matchesKey(data, Key.ctrl("c"))) {
                            return;
                        }

                        // 箭头键导航、Ctrl+O 切换等：若已处理则重新渲染，
                        // 否则（任意其他键按下）关闭查看器
                        if (viewer.handleInput(data)) {
                            tui.requestRender();
                        } else {
                            closeViewer();
                        }

                        /** 关闭查看器并恢复主屏幕。 */
                        function closeViewer(): void {
                            viewer.dispose();
                            terminal.write(ALT_SCREEN_EXIT);
                            tui.requestRender(true);
                            viewerOpen = false;
                            done(undefined);
                        }
                    },

                    invalidate: () => viewer.invalidate(),
                };
            },
            {
                overlay: true,
                overlayOptions: {
                    width: "100%",
                    maxHeight: "100%",
                    anchor: "center",
                },
            },
        );
    }

    // -- 事件处理器 ----------------------------------------------------------

    // 当新的代理轮次开始时重置状态，标记 working，并根据配置决定是否自动打开历史查看器
    pi.on("agent_start", async (_event, ctx) => {
        resetTurnState(ctx.cwd);
        currentCtx = ctx;
        isWorking = true;
        requestRender();

        // 根据配置文件决定是否自动打开历史查看器
        const config = loadConfig(ctx.cwd);
        if (config.autoOpenOnStart) {
            openHistoryView(ctx);
        }
    });

    // Agent 处理完成时清除 working 状态
    pi.on("agent_end", async () => {
        isWorking = false;
        requestRender();
    });

    // Ctrl+H：打开历史覆盖层
    pi.registerShortcut("ctrl+h", {
        description: "打开历史查看器",
        handler: async (ctx) => {
            openHistoryView(ctx);
        },
    });

    // -- 消息生命周期 ---------------------------------------------------------

    /**
     * message_start：立即创建助手消息组件，
     * 以便它可以接收流式内容更新。
     */
    pi.on("message_start", (event) => {
        if (event.message.role !== "assistant") return;

        streamingAssistant = new AssistantMessageComponent(
            event.message as AssistantMessage,
            false, // hideThinkingBlock
            markdownTheme,
        );
        messageComponents.push(streamingAssistant);
        requestRender();
    });

    /** message_update：用部分内容更新正在流式输出的助手组件。 */
    pi.on("message_update", (event) => {
        if (event.message.role !== "assistant" || !streamingAssistant) return;

        streamingAssistant.updateContent(event.message as AssistantMessage);
        requestRender();
    });

    /**
     * message_end：完成消息处理。
     *   - 用户消息：渲染为 UserMessageComponent。
     *   - 助手消息：完成被追踪的流式组件，
     *     或创建一个新的（边缘情况）。
     */
    pi.on("message_end", (event) => {
        const message = event.message;

        switch (message.role) {
            case "user": {
                const text = extractUserMessageText(message.content);
                messageComponents.push(
                    new UserMessageComponent(text, markdownTheme),
                );
                break;
            }
            case "assistant": {
                if (streamingAssistant) {
                    streamingAssistant.updateContent(
                        message as AssistantMessage,
                    );
                    streamingAssistant = null;
                } else {
                    // 边缘情况：没有流式组件被创建
                    messageComponents.push(
                        new AssistantMessageComponent(
                            message as AssistantMessage,
                            false,
                            markdownTheme,
                        ),
                    );
                }
                break;
            }
        }

        requestRender();
    });

    // 将 tool_execution_start 的组件创建逻辑接上
    pi.on("tool_execution_start", (event) => {
        createToolComponentForEvent(
            event.toolName,
            event.toolCallId,
            event.args,
        );
    });

    /** tool_execution_update：将部分/流式结果推送到组件。 */
    pi.on("tool_execution_update", (event) => {
        const component = toolRegistry.get(event.toolCallId);
        if (!component || !event.partialResult) return;
        component.updateResult(
            {
                content: event.partialResult.content || [],
                isError: false,
            },
            true, // isPartial
        );
        requestRender();
    });

    /** tool_execution_end：将最终的工具结果推送到组件。 */
    pi.on("tool_execution_end", (event) => {
        const component = toolRegistry.get(event.toolCallId);
        if (!component || !event.result) return;
        component.updateResult(
            {
                content: event.result.content || [],
                isError: event.isError,
            },
            false, // 最终结果，非部分更新
        );
        requestRender();
    });

    /** 为此工具调用创建合适的组件。 */
    function createToolComponentForEvent(
        toolName: string,
        toolCallId: string,
        args: unknown,
    ) {
        const component = createToolComponent(toolName, toolCallId, args);
        toolRegistry.set(toolCallId, component);
        messageComponents.push(component);
        requestRender();
    }

    /** 根据工具类型创建合适的组件。 */
    function createToolComponent(
        toolName: string,
        toolCallId: string,
        args: unknown,
    ): ToolExecutionComponent {
        if (BUILT_IN_TOOL_NAMES.has(toolName)) {
            const toolDef = createBuiltInToolDefinition(toolName, workingDir);
            if (toolDef) {
                const component = new ToolExecutionComponent(
                    toolName,
                    toolCallId,
                    args,
                    undefined, // options
                    toolDef as any,
                    createTuiWrapper(),
                    workingDir,
                );
                component.markExecutionStarted();
                component.setArgsComplete();
                return component;
            }
        }

        // subagent：使用 ToolExecutionComponent 与内置工具保持一致的渲染管线
        if (toolName === "subagent") {
            const toolDef = createSubagentToolDefinition();
            const component = new ToolExecutionComponent(
                toolName,
                toolCallId,
                args,
                undefined, // options
                toolDef as any,
                createTuiWrapper(),
                workingDir,
            );
            component.markExecutionStarted();
            component.setArgsComplete();
            return component;
        }

        // junie_ai：使用 ToolExecutionComponent 与内置工具保持一致的渲染管线
        if (toolName === "junie_ai") {
            const toolDef = createJunieAiToolDefinition();
            const component = new ToolExecutionComponent(
                toolName,
                toolCallId,
                args,
                undefined, // options
                toolDef as any,
                createTuiWrapper(),
                workingDir,
            );
            component.markExecutionStarted();
            component.setArgsComplete();
            return component;
        }

        // 回退：使用 ToolExecutionComponent 的内置 fallback 渲染
        const component = new ToolExecutionComponent(
            toolName,
            toolCallId,
            args,
            undefined,
            undefined,
            createTuiWrapper(),
            workingDir,
        );
        component.markExecutionStarted();
        component.setArgsComplete();
        return component;
    }
}
