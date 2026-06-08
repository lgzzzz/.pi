/**
 * 历史扩展
 *
 * 显示当前轮次所有消息的可滚动历史视图。
 * 通过 Ctrl+H 在备用屏幕中打开，按 ESC 关闭。
 *
 * 功能：
 *   - 渲染用户消息、助手消息以及工具调用/结果
 *   - 使用箭头键 / 鼠标滚轮滚动（3 行和整页增量）
 *   - 内置工具（read/edit/write/bash）使用 pi 的原生 ToolExecutionComponent
 *     进行富文本 diff/代码渲染
 *   - 其他工具使用通用的 ToolCallComponent，支持折叠/展开结果
 *   - Ctrl+O 同时切换所有工具结果的展开/折叠状态
 *
 * 目录结构：
 *   index.ts               — 扩展入口（事件处理器 + 覆盖层逻辑）
 *   constants.ts           — 共享常量（魔数、ANSI 序列）
 *   theme.ts               — 主题访问辅助函数
 *   helpers.ts             — 格式化、内容提取、工具定义工厂
 *   ToolCallComponent.ts   — 通用工具调用/结果渲染（用于非内置工具）
 *   HistoryViewer.ts       — 可滚动视口控制器（渲染 + 输入处理）
 *   mouse.ts               — SGR 鼠标滚动事件解析器
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
import { extractTextFromContent, extractUserMessageText, createBuiltInToolDefinition } from "./helpers.js";
import { ToolCallComponent } from "./ToolCallComponent.js";
import { HistoryViewer } from "./HistoryViewer.js";
import { parseSGRMouseScroll } from "./mouse.js";
import { loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// 类型别名
// ---------------------------------------------------------------------------

/** 将 toolCallId 映射到对应的渲染组件。 */
type ToolRegistry = Map<string, ToolCallComponent | ToolExecutionComponent>;

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

    // -- 覆盖层管理 ----------------------------------------------------------

    /** 在备用屏幕中以全屏覆盖层的形式打开历史查看器。 */
    function openHistoryView(ctx: { ui: { custom: Function }; mode?: string; hasUI?: boolean }): void {
        // 仅在 TUI 模式下可用
        if (ctx.mode !== undefined && ctx.mode !== "tui") return;
        if (ctx.hasUI === false) return;

        // 如果已经打开，不要重复打开
        if (viewerOpen) return;
        viewerOpen = true;
        const viewer = new HistoryViewer(() => messageComponents);

        ctx.ui.custom(
            (
                tui: TUI,
                _theme: unknown,
                _kb: unknown,
                done: (result?: unknown) => void,
            ) => {
                overlayTui = tui;
                const terminal = tui.terminal;

                // 进入备用屏幕，启用鼠标追踪
                terminal.write(ALT_SCREEN_ENTER);

                // 在空白备用屏幕上强制进行全量渲染
                tui.requestRender(true);

                return {
                    render: (width: number) => viewer.render(width, tui.terminal.rows),

                    handleInput: (data: string) => {
                        // ESC：关闭覆盖层并返回主屏幕
                        if (matchesKey(data, Key.esc)) {
                            terminal.write(ALT_SCREEN_EXIT);
                            tui.requestRender(true);
                            viewerOpen = false;
                            done(undefined);
                            return;
                        }

                        // 鼠标滚轮滚动
                        if (data.startsWith("\x1b[<")) {
                            const delta = parseSGRMouseScroll(data);
                            if (delta !== 0) {
                                viewer.scrollBy(delta);
                                tui.requestRender();
                            }
                            return;
                        }

                        // 所有其他输入（箭头键、Ctrl+O 等）
                        viewer.handleInput(data);
                        tui.requestRender();
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

    // 当新的代理轮次开始时重置状态，并根据配置决定是否自动打开历史查看器
    pi.on("agent_start", async (_event, ctx) => {
        resetTurnState(ctx.cwd);

        // 根据配置文件决定是否自动打开历史查看器
        const config = loadConfig(ctx.cwd);
        if (config.autoOpenOnStart) {
            openHistoryView(ctx);
        }
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

    // -- 工具执行生命周期 ----------------------------------------------------

    /**
     * tool_execution_start：为此工具创建合适的组件。
     *   - 内置工具（read/edit/write/bash）→ pi 的原生 ToolExecutionComponent
     *     带富文本 diff/代码渲染。
     *   - 所有其他工具 → 通用 ToolCallComponent。
     */
    pi.on("tool_execution_start", (event) => {
        const component = createToolComponent(
            event.toolName,
            event.toolCallId,
            event.args,
        );
        toolRegistry.set(event.toolCallId, component);
        messageComponents.push(component);
        requestRender();
    });

    /** 根据工具类型创建合适的组件。 */
    function createToolComponent(
        toolName: string,
        toolCallId: string,
        args: unknown,
    ): ToolCallComponent | ToolExecutionComponent {
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

        // 回退：为非内置工具使用通用组件
        return new ToolCallComponent(toolName, args);
    }

    /** tool_execution_update：将部分/流式结果推送到组件。 */
    pi.on("tool_execution_update", (event) => {
        const component = toolRegistry.get(event.toolCallId);
        if (!component || !event.partialResult) return;

        if (component instanceof ToolExecutionComponent) {
            component.updateResult(
                {
                    content: event.partialResult.content || [],
                    isError: false,
                },
                true, // isPartial
            );
        } else {
            component.updateResult(
                extractTextFromContent(event.partialResult.content || []),
            );
        }

        requestRender();
    });

    /** tool_execution_end：将最终的工具结果推送到组件。 */
    pi.on("tool_execution_end", (event) => {
        const component = toolRegistry.get(event.toolCallId);
        if (!component || !event.result) return;

        if (component instanceof ToolExecutionComponent) {
            component.updateResult(
                {
                    content: event.result.content || [],
                    isError: event.isError,
                },
                false, // 最终结果，非部分更新
            );
        } else {
            component.updateResult(
                extractTextFromContent(event.result.content || []),
            );
        }

        requestRender();
    });
}
