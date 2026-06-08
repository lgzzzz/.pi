/**
 * History Extension
 *
 * Displays a scrollable history view of the current turn's messages.
 * Opens via Ctrl+K and closes on ESC.
 *
 * Features:
 * - Shows user, assistant, tool call, and tool result messages
 * - Scrollable with line/page navigation
 * - Manual open via Ctrl+K, close via ESC
 * - Tool calls rendered following junie.ts renderCall/renderResult pattern:
 *     bold title + truncated args (120 chars) for calls,
 *     collapsed (8-line preview) / expanded (full markdown) for results,
 *     toggle with Ctrl+O key
 */

import {
    ExtensionAPI,
    UserMessageComponent,
    AssistantMessageComponent,
    getMarkdownTheme,
    keyHint,
    ToolExecutionComponent,
    createReadToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { TextContent, AssistantMessage } from "@earendil-works/pi-ai";
import {
    matchesKey,
    Key,
    Component,
    Container,
    Text,
    TUI,
    Markdown,
} from "@earendil-works/pi-tui";

/** Theme instance — accessed from globalThis (set by pi via initTheme) */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function getTheme(): {
    fg(color: string, text: string): string;
    bold(text: string): string;
    italic(text: string): string;
} {
    return (globalThis as Record<symbol, unknown>)[THEME_KEY] as ReturnType<
        typeof getTheme
    >;
}

/** Number of lines to show in collapsed result preview (matches junie.ts JUNIE_PREVIEW_LINES) */
const RESULT_PREVIEW_LINES = 7;

// =============================================================================
// Built-in tool names that use pi's native ToolExecutionComponent
// =============================================================================

const BUILT_IN_TOOL_NAMES = new Set(["read", "edit", "write", "bash"]);

/** Tool definition factory for pi's built-in tools (used for rendering only). */
function createToolDefinitionForName(name: string, cwd: string): any {
    switch (name) {
        case "read":
            return createReadToolDefinition(cwd);
        case "edit":
            return createEditToolDefinition(cwd);
        case "write":
            return createWriteToolDefinition(cwd);
        case "bash":
            return createBashToolDefinition(cwd);
        default:
            return undefined;
    }
}

// =============================================================================
// Args Preview Formatter
// =============================================================================

/**
 * 将 tool args 格式化为简短预览字符串。
 * 参考 junie.ts renderCall 中截断到 ~120 字符的样式。
 */
function formatArgsPreview(args: unknown): string {
    if (args === null || args === undefined) {
        return "";
    }
    if (typeof args === "string") {
        return args;
    }
    if (typeof args !== "object" || Array.isArray(args)) {
        return String(args);
    }
    const entries = Object.entries(args as Record<string, unknown>);
    if (entries.length === 0) {
        return "";
    }
    const parts = entries.map(([k, v]) => {
        const vs = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
        return `${k}: ${vs}`;
    });
    return parts.join("\n");
}

// =============================================================================
// ToolCallComponent — 参考 junie.ts renderCall + renderResult 的模式
// =============================================================================

/**
 * 自定义组件：按 junie.ts 的 renderCall/renderResult 风格渲染工具调用。
 * 用于非内置工具（如 junie_ai, subagent 等）。
 *
 * renderCall 风格:
 *   ### {toolName}             (bold title)
 *   {truncated args preview}   (args 截断到 120 字符)
 *
 * renderResult 风格:
 *   - 空/partial: "(No output)" 或 "Calling Junie AI..."
 *   - 折叠模式:   前 8 行预览 + "(Enter to expand — N lines total)"
 *   - 展开模式:   markdown 全量渲染 + "(Enter to collapse)"
 */
class ToolCallComponent extends Container {
    private toolName: string;
    private resultContent: string = "";
    private expanded: boolean = false;
    /** children 数组中 result 区域的起始索引 */
    private resultStartIndex: number;

    constructor(toolName: string, args: unknown) {
        super();
        this.toolName = toolName;

        // ---- renderCall 风格（与 junie.ts 一致）----
        // 工具名称（bold + toolTitle 颜色）
        this.addChild(
            new Text(
                getTheme().fg("toolTitle", getTheme().bold(toolName)),
                1,
                0,
            ),
        );

        // args 预览（muted 颜色，截断到 ~120 字符）
        const argsPreview = formatArgsPreview(args);
        if (argsPreview) {
            const truncated =
                argsPreview.length > 120
                    ? argsPreview.slice(0, 120) + "..."
                    : argsPreview;
            this.addChild(new Text(getTheme().fg("muted", truncated), 2, 0));
        }

        // 记录 result 区域起始位置
        this.resultStartIndex = this.children.length;

        // 初始空占位
        this.addChild(new Text("", 2, 0));
    }

    /** 更新工具结果 — 参考 junie.ts renderResult */
    updateResult(result: string): void {
        this.resultContent = result;
        this.expanded = false;
        this.rebuildResult();
        this.invalidate();
    }

    /** 展开/折叠切换 */
    toggleExpand(): boolean {
        if (!this.isExpandable()) return false;
        this.expanded = !this.expanded;
        this.rebuildResult();
        this.invalidate();
        return true;
    }

    /** 是否可展开（内容超过预览行数） */
    isExpandable(): boolean {
        return this.resultContent.split("\n").length > RESULT_PREVIEW_LINES;
    }

    /** 重建 result 子节点 */
    private rebuildResult(): void {
        // 移除 resultStartIndex 及之后的所有子节点
        this.children.splice(this.resultStartIndex);

        // 空内容 — 参考 junie.ts renderResult 的 partial/empty 处理
        if (!this.resultContent.trim()) {
            this.addChild(
                new Text(
                    this.toolName === "junie_ai"
                        ? getTheme().fg("warning", "Calling Junie AI...")
                        : getTheme().fg("muted", "(No output)"),
                    2,
                    0,
                ),
            );
            return;
        }

        // 展开模式 — 参考 junie.ts renderResult expanded
        if (this.expanded) {
            this.addChild(
                new Markdown(this.resultContent, 2, 0, getMarkdownTheme()),
            );
            this.addChild(
                new Text(
                    `(${keyHint("app.tools.expand", "to collapse")})`,
                    2,
                    0,
                ),
            );
            return;
        }

        // 折叠模式 — 参考 junie.ts renderResult collapsed (8 行预览，toolOutput 颜色)
        const lines = this.resultContent.split("\n");
        const preview = lines
            .slice(0, RESULT_PREVIEW_LINES)
            .map((l) => getTheme().fg("toolOutput", l))
            .join("\n");
        this.addChild(new Text(preview, 2, 0));
        if (lines.length > RESULT_PREVIEW_LINES) {
            this.addChild(
                new Text(
                    getTheme().fg(
                        "muted",
                        `(${keyHint("app.tools.expand", "to expand")})`,
                    ),
                    2,
                    0,
                ),
            );
        }
    }
}

// =============================================================================
// Type Definitions
// =============================================================================

interface MessageListProvider {
    (): Component[];
}

// =============================================================================
// HistoryViewer
// =============================================================================

class HistoryViewer {
    private getMessages: MessageListProvider;
    private scrollOffset: number = 0;
    private currentWidth: number = 0;
    private actualContentLines: number = 0;

    public onClose?: () => void;

    constructor(getMessages: MessageListProvider) {
        this.getMessages = getMessages;
    }

    /** Compute the starting offset of each message in the rendered allLines array. */
    private computeMessageOffsets(
        messages: Component[],
        width: number,
    ): number[] {
        const offsets: number[] = [];
        let cumulative = 0;
        for (const msg of messages) {
            offsets.push(cumulative);
            const lines = msg.render(width);
            cumulative += lines.length > 0 ? lines.length + 1 : 0;
        }
        return offsets;
    }

    handleInput(data: string): void {
        // At bottom: top 32 lines show last content, bottom 32 lines are empty
        const maxScroll = Math.max(0, this.actualContentLines - 13);

        if (matchesKey(data, Key.up)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - 3);
        } else if (matchesKey(data, Key.down)) {
            this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 3);
        } else if (matchesKey(data, Key.left)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - 13);
        } else if (matchesKey(data, Key.right)) {
            this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 13);
        } else if (matchesKey(data, Key.esc)) {
            this.onClose?.();
        } else if (matchesKey(data, Key.ctrl("o"))) {
            // Toggle expand/collapse on all expandable tool call components.
            // Adjust scrollOffset so the content the user was viewing stays visible
            // (expanding tool calls adds lines before the current viewport, pushing content down).
            const messages = this.getMessages();
            let toggled = false;

            if (this.currentWidth > 0 && messages.length > 0) {
                // Pre-expansion: compute message offsets and find what's at the viewport top
                const preOffsets = this.computeMessageOffsets(
                    messages,
                    this.currentWidth,
                );
                let msgIndex = 0;
                let innerOffset = 0;
                for (let i = preOffsets.length - 1; i >= 0; i--) {
                    if (preOffsets[i] <= this.scrollOffset) {
                        msgIndex = i;
                        innerOffset = this.scrollOffset - preOffsets[i];
                        break;
                    }
                }

                // Toggle all expandable tool calls
                for (const msg of messages) {
                    if (
                        msg instanceof ToolCallComponent &&
                        msg.isExpandable()
                    ) {
                        msg.toggleExpand();
                        toggled = true;
                    } else if (msg instanceof ToolExecutionComponent) {
                        // ToolExecutionComponent always supports toggling
                        // Use (msg as any).expanded to access the runtime property (TypeScript marks it private)
                        const currentExpanded = !!(msg as any).expanded;
                        msg.setExpanded(!currentExpanded);
                        toggled = true;
                    }
                }

                if (toggled) {
                    // Post-expansion: find the new position of the same message
                    const postOffsets = this.computeMessageOffsets(
                        messages,
                        this.currentWidth,
                    );
                    const newOffset = postOffsets[msgIndex] + innerOffset;
                    this.scrollOffset = Math.max(0, newOffset);
                }
            } else {
                // Fallback: just toggle without offset adjustment
                for (const msg of messages) {
                    if (
                        msg instanceof ToolCallComponent &&
                        msg.isExpandable()
                    ) {
                        msg.toggleExpand();
                        toggled = true;
                    } else if (msg instanceof ToolExecutionComponent) {
                        const currentExpanded = !!(msg as any).expanded;
                        msg.setExpanded(!currentExpanded);
                        toggled = true;
                    }
                }
            }
        }
    }

    render(width: number): string[] {
        this.currentWidth = width;
        const turnMessages = this.getMessages();
        const allLines: string[] = [];
        // Render messages
        for (const turnMsg of turnMessages) {
            const lines = turnMsg.render(width);
            if (lines.length > 0) {
                allLines.push(...lines);
                allLines.push("");
            }
        }
        this.actualContentLines = allLines.length;

        for (let i = 0; i < 64; i++) {
            allLines.push("");
        }

        const startLine = this.scrollOffset;
        const endLine = Math.min(startLine + 64, allLines.length);
        const result = allLines.slice(startLine, endLine);

        return result;
    }

    invalidate(): void {}
}

function isTextContent(obj: any): obj is TextContent {
    return obj && typeof obj === "object" && "text" in obj;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
    let currentTurnMessages: Component[] = [];
    let toolExecutionComponent: Map<
        string,
        ToolCallComponent | ToolExecutionComponent
    > | null = null;
    /** Current streaming assistant message component. Only one streams at a time, so a direct reference suffices. */
    let streamingAssistantComponent: AssistantMessageComponent | null = null;
    let historyViewer: HistoryViewer | null = null;
    let tuiRef: TUI | null = null;
    let cwd: string = "";

    const markdownTheme = getMarkdownTheme();

    /** Trigger a re-render of the overlay if the TUI is available. */
    function requestOverlayRender() {
        tuiRef?.requestRender();
    }

    /** Extract text parts from a content array (TextContent | ImageContent). */
    function extractTextFromContent(content: unknown[]): string {
        const textParts: string[] = [];
        for (const item of content) {
            if (item && typeof item === "object" && "type" in item) {
                if ((item as any).type === "text" && (item as any).text) {
                    textParts.push((item as any).text);
                } else if ((item as any).type === "image") {
                    textParts.push("[Image]");
                }
            }
        }
        return textParts.join("\n");
    }

    /** Open the history viewer overlay. */
    function openHistoryOverlay(ctx: any) {
        historyViewer = new HistoryViewer(() => currentTurnMessages);
        ctx.ui.custom(
            (
                tui: TUI,
                _theme: any,
                _kb: any,
                done: (result?: unknown) => void,
            ) => {
                tuiRef = tui;
                historyViewer!.onClose = () => done(undefined);
                return {
                    render: (width: number) => historyViewer!.render(width),
                    handleInput: (data: string) => {
                        historyViewer!.handleInput(data);
                        tui.requestRender();
                    },
                    invalidate: () => historyViewer!.invalidate(),
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

    // agent_start: reset messages for new turn
    pi.on("agent_start", async (_event, ctx) => {
        currentTurnMessages = [];
        toolExecutionComponent = new Map<
            string,
            ToolCallComponent | ToolExecutionComponent
        >();
        streamingAssistantComponent = null;
        tuiRef = null;
        cwd = ctx.cwd;
    });

    // Ctrl+K: open history viewer
    pi.registerShortcut("ctrl+h", {
        description: "Open history viewer",
        handler: async (ctx) => {
            openHistoryOverlay(ctx);
        },
    });

    function getTuiWrapper(): TUI {
        return { requestRender: () => tuiRef?.requestRender() } as TUI;
    }

    // message_start: create assistant message component immediately (before streaming completes)
    pi.on("message_start", (event) => {
        const msg = event.message;
        if (msg.role === "assistant") {
            const comp = new AssistantMessageComponent(
                msg as AssistantMessage,
                false,
                markdownTheme,
            );
            streamingAssistantComponent = comp;
            currentTurnMessages.push(comp);
            requestOverlayRender();
        }
    });

    // message_update: update assistant message component with partial/streaming content
    pi.on("message_update", (event) => {
        const msg = event.message;
        if (msg.role === "assistant" && streamingAssistantComponent) {
            streamingAssistantComponent.updateContent(msg as AssistantMessage);
            requestOverlayRender();
        }
    });

    pi.on("message_end", (event) => {
        const msg = event.message;
        switch (msg.role) {
            case "user":
                if (typeof msg.content === "string") {
                    currentTurnMessages.push(
                        new UserMessageComponent(msg.content, markdownTheme),
                    );
                } else if (Array.isArray(msg.content)) {
                    const textParts: string[] = [];
                    for (const item of msg.content) {
                        if (isTextContent(item)) {
                            textParts.push(item.text);
                        } else {
                            textParts.push("[Image]");
                        }
                    }
                    currentTurnMessages.push(
                        new UserMessageComponent(
                            textParts.join("\n"),
                            markdownTheme,
                        ),
                    );
                }
                break;
            case "assistant": {
                // If we already have a tracked component from message_start, do a final update.
                // Otherwise fall back to creating a new component (edge case).
                if (streamingAssistantComponent) {
                    streamingAssistantComponent.updateContent(
                        msg as AssistantMessage,
                    );
                    streamingAssistantComponent = null;
                } else {
                    currentTurnMessages.push(
                        new AssistantMessageComponent(
                            msg as AssistantMessage,
                            false,
                            markdownTheme,
                        ),
                    );
                }
                break;
            }
        }
        requestOverlayRender();
    });

    // tool_execution_start:
    // - For built-in tools (edit, bash, write, read): use pi's native ToolExecutionComponent
    //   which leverages the tool definitions' renderCall/renderResult for rich rendering
    //   (highlighted code, diffs, borders, etc.)
    // - For other tools (e.g. junie_ai, subagent): use the generic ToolCallComponent
    pi.on("tool_execution_start", (event, _ctx) => {
        const toolName = event.toolName;
        if (BUILT_IN_TOOL_NAMES.has(toolName)) {
            // Use pi's native ToolExecutionComponent with the built-in tool definition
            // This provides rich rendering: highlighted code for read/write,
            // diff preview for edit, streaming output for bash, etc.
            const toolDef = createToolDefinitionForName(toolName, cwd);
            if (toolDef) {
                const tc = new ToolExecutionComponent(
                    toolName,
                    event.toolCallId,
                    event.args,
                    undefined,
                    toolDef as any,
                    getTuiWrapper(),
                    cwd,
                );
                tc.markExecutionStarted();
                tc.setArgsComplete();
                toolExecutionComponent!.set(event.toolCallId, tc);
                currentTurnMessages.push(tc);
                requestOverlayRender();
                return;
            }
        }
        // Use generic ToolCallComponent for non-built-in tools or if tool definition creation failed
        const tc = new ToolCallComponent(toolName, event.args);
        toolExecutionComponent!.set(event.toolCallId, tc);
        currentTurnMessages.push(tc);
        requestOverlayRender();
    });

    // tool_execution_update: update partial/streaming tool results
    pi.on("tool_execution_update", (event, _ctx) => {
        const tc = toolExecutionComponent?.get(event.toolCallId);
        if (tc && event.partialResult) {
            if (tc instanceof ToolExecutionComponent) {
                // ToolExecutionComponent expects the full result object with content and isPartial flag
                tc.updateResult(
                    {
                        content: event.partialResult.content || [],
                        isError: false,
                    },
                    true, // isPartial
                );
            } else {
                // ToolCallComponent expects plain text
                tc.updateResult(
                    extractTextFromContent(event.partialResult.content || []),
                );
            }
            requestOverlayRender();
        }
    });

    // tool_execution_end: final tool result
    pi.on("tool_execution_end", (event, _ctx) => {
        const tc = toolExecutionComponent?.get(event.toolCallId);
        if (tc && event.result) {
            if (tc instanceof ToolExecutionComponent) {
                // ToolExecutionComponent expects the full result object
                tc.updateResult(
                    {
                        content: event.result.content || [],
                        isError: event.isError,
                    },
                    false, // isPartial = false (final result)
                );
            } else {
                // ToolCallComponent expects plain text
                tc.updateResult(
                    extractTextFromContent(event.result.content || []),
                );
            }
            requestOverlayRender();
        }
    });
}
