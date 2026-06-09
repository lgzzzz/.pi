/**
 * 历史扩展 — ToolCallComponent
 *
 * 为没有原生 pi ToolDefinition 渲染器的工具（如 junie_ai）
 * 渲染工具调用及其结果的通用组件。
 *
 * 默认渲染：
 *   调用渲染：粗体工具名称（toolTitle 颜色）
 *           + 截断的参数预览（muted 颜色，最多 ARGS_PREVIEW_MAX_LENGTH 字符）
 *   结果渲染：三种模式 —
 *     - 空：       "(No output)"（muted 颜色）
 *     - 折叠：    前 RESULT_PREVIEW_LINES 行 + "(按键展开)" 提示
 *     - 展开：    完整 markdown 渲染 + "(按键折叠)" 提示
 *
 * 自定义渲染（通过 customRenderCall / customRenderResult 传入）：
 *   当提供时，完全替代上述默认渲染逻辑，
 *   使工具在历史查看器中与主界面保持一致。
 *
 * 通过 Ctrl+O（由 HistoryViewer 处理）在折叠/展开之间切换。
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Text,
    Markdown,
    type Component,
} from "@earendil-works/pi-tui";
import { getTheme, type Theme } from "./theme.js";
import { formatArgsPreview, buildCollapsedToolPreview } from "./helpers.js";
import { ARGS_PREVIEW_MAX_LENGTH, RESULT_PREVIEW_LINES } from "./constants.js";

// ---------------------------------------------------------------------------
// 自定义渲染器类型
// ---------------------------------------------------------------------------

/** 自定义 renderCall 签名：接收 args + theme，返回一个 Component */
export type CustomRenderCall = (args: unknown, theme: Theme) => Component;

/** 自定义 renderResult 签名：接收 result + options + theme，返回一个 Component */
export type CustomRenderResult = (
    result: unknown,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
) => Component;

// ---------------------------------------------------------------------------
// ToolCallComponent
// ---------------------------------------------------------------------------

export class ToolCallComponent extends Container {
    private readonly toolName: string;

    /** 默认渲染器使用的文本结果（自定义渲染器不使用此字段）。 */
    private resultContent: string = "";

    /** 自定义渲染器使用的完整结果对象。 */
    private fullResult: unknown = null;

    /** 当前结果是否为部分/流式更新（仅自定义渲染器使用）。 */
    private isPartialResult: boolean = false;

    private expanded: boolean = false;

    /**
     * this.children 中结果子组件起始位置的索引。
     * 重建结果区域时，从此索引处向后截断。
     */
    private readonly resultStartIndex: number;

    /** 自定义调用渲染器（如果提供）。 */
    private readonly customRenderCall?: CustomRenderCall;

    /** 自定义结果渲染器（如果提供）。 */
    private readonly customRenderResult?: CustomRenderResult;

    /** 是否使用了自定义结果渲染器（供外部判断以选择调用方式）。 */
    readonly hasCustomResultRenderer: boolean;

    constructor(
        toolName: string,
        args: unknown,
        customRenderCall?: CustomRenderCall,
        customRenderResult?: CustomRenderResult,
    ) {
        super();
        this.toolName = toolName;
        this.customRenderCall = customRenderCall;
        this.customRenderResult = customRenderResult;
        this.hasCustomResultRenderer = !!customRenderResult;

        // 渲染调用头部（默认或自定义）
        if (customRenderCall) {
            const component = customRenderCall(args, getTheme());
            this.addChild(component);
        } else {
            this.renderCallHeader(args);
        }

        // 记录结果子组件的起始位置
        this.resultStartIndex = this.children.length;

        // 初始的空结果占位符
        this.addChild(new Text("", 2, 0));
    }

    // -- 公开 API ------------------------------------------------------------

    /**
     * 更新文本结果（供默认渲染器使用）。
     * 在 tool_execution_update / tool_execution_end 中调用。
     */
    updateResult(resultText: string): void {
        this.resultContent = resultText;
        this.expanded = false;
        this.rebuildResultArea();
        this.invalidate();
    }

    /**
     * 更新完整结果对象（供自定义渲染器使用）。
     * 在 tool_execution_update / tool_execution_end 中调用。
     */
    updateFullResult(fullResult: unknown, isPartial: boolean): void {
        this.fullResult = fullResult;
        this.isPartialResult = isPartial;
        if (!isPartial) {
            this.expanded = false;
        }
        this.rebuildResultArea();
        this.invalidate();
    }

    /** 在折叠和展开结果视图之间切换。若已切换则返回 true。 */
    toggleExpand(): boolean {
        if (!this.isExpandable()) return false;
        this.expanded = !this.expanded;
        this.rebuildResultArea();
        this.invalidate();
        return true;
    }

    /**
     * 结果内容是否有足够多的行，使折叠功能有意义。
     *
     * 自定义渲染器：始终可切换（由渲染函数本身决定显示内容）。
     * 默认渲染器：检查行数是否超过 RESULT_PREVIEW_LINES。
     */
    isExpandable(): boolean {
        if (this.customRenderResult) {
            // 自定义渲染器总是可展开的（渲染函数根据 expanded 状态自行处理）
            // 但只对非 partial 和非 error 的结果有意义
            if (this.isPartialResult) return false;
            const details = (this.fullResult as Record<string, unknown> | undefined)?.details as
                | Record<string, unknown>
                | undefined;
            if (details?.error) return false;
            const content = ((this.fullResult as Record<string, unknown> | undefined)?.content ?? []) as Array<{ type: string; text?: string }>;
            const text = content.filter(c => c.type === "text").map(c => c.text || "").join("\n");
            return text.trim().length > 0;
        }
        return this.resultContent.split("\n").length > RESULT_PREVIEW_LINES;
    }

    // -- 内部渲染 ------------------------------------------------------------

    /** 构建调用头部：粗体工具名称 + 截断的参数预览。 */
    private renderCallHeader(args: unknown): void {
        // 工具名称行
        this.addChild(
            new Text(
                getTheme().fg("toolTitle", getTheme().bold(this.toolName)),
                1, // x
                0, // y
            ),
        );

        // 参数预览行
        const argsPreview = formatArgsPreview(args);
        if (argsPreview) {
            const displayText = argsPreview.length > ARGS_PREVIEW_MAX_LENGTH
                ? argsPreview.slice(0, ARGS_PREVIEW_MAX_LENGTH) + "..."
                : argsPreview;
            this.addChild(
                new Text(getTheme().fg("muted", displayText), 2, 0),
            );
        }
    }

    /** 移除结果子组件并根据当前状态重建它们。 */
    private rebuildResultArea(): void {
        // 从 resultStartIndex 开始移除所有子组件
        this.children.splice(this.resultStartIndex);

        // 自定义渲染器路径
        if (this.customRenderResult && this.fullResult !== null) {
            const component = this.customRenderResult(
                this.fullResult,
                { expanded: this.expanded, isPartial: this.isPartialResult },
                getTheme(),
            );
            this.addChild(component);
            return;
        }

        // 默认渲染器路径
        // 空内容
        if (!this.resultContent.trim()) {
            this.addChild(this.buildEmptyResult());
            return;
        }

        // 展开模式
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

        // 折叠模式
        this.buildCollapsedResult();
    }

    /** 返回在没有结果内容时显示的 Text 组件。 */
    private buildEmptyResult(): Text {
        return new Text(getTheme().fg("muted", "(No output)"), 2, 0);
    }

    /** 构建折叠的结果预览：前 N 行 + 展开提示。 */
    private buildCollapsedResult(): void {
        const preview = buildCollapsedToolPreview(
            this.resultContent,
            RESULT_PREVIEW_LINES,
            (color, s) => getTheme().fg(color, s),
            `(${keyHint("app.tools.expand", "to expand")})`,
        );
        this.addChild(new Text(preview, 2, 0));
    }
}
