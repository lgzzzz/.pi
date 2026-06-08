/**
 * 历史扩展 — ToolCallComponent
 *
 * 为没有原生 pi ToolDefinition 渲染器的工具（如 junie_ai）
 * 渲染工具调用及其结果的通用组件。
 *
 * 调用渲染：  粗体工具名称（toolTitle 颜色）
 *            + 截断的参数预览（muted 颜色，最多 ARGS_PREVIEW_MAX_LENGTH 字符）
 *
 * 结果渲染：三种模式 —
 *   - 空/部分加载：  "(No output)" 或 "Calling Junie AI..."（warning 颜色）
 *   - 折叠：         前 RESULT_PREVIEW_LINES 行 + "(按键展开)" 提示
 *   - 展开：         完整 markdown 渲染 + "(按键折叠)" 提示
 *
 * 通过 Ctrl+O（由 HistoryViewer 处理）在折叠/展开之间切换。
 *
 * 此组件镜像了 junie.ts 中使用的 renderCall/renderResult 模式。
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Text,
    Markdown,
} from "@earendil-works/pi-tui";
import { getTheme } from "./theme.js";
import { formatArgsPreview } from "./helpers.js";
import { ARGS_PREVIEW_MAX_LENGTH, RESULT_PREVIEW_LINES } from "./constants.js";

export class ToolCallComponent extends Container {
    private readonly toolName: string;
    private resultContent: string = "";
    private expanded: boolean = false;

    /**
     * this.children 中结果子组件起始位置的索引。
     * 重建结果区域时，从此索引处向后截断。
     */
    private readonly resultStartIndex: number;

    constructor(toolName: string, args: unknown) {
        super();
        this.toolName = toolName;

        // 渲染调用头部（工具名称 + 参数预览）
        this.renderCallHeader(args);

        // 记录结果子组件的起始位置
        this.resultStartIndex = this.children.length;

        // 初始的空结果占位符
        this.addChild(new Text("", 2, 0));
    }

    // -- 公开 API ------------------------------------------------------------

    /** 更新工具结果内容（在部分和最终更新时调用）。 */
    updateResult(resultText: string): void {
        this.resultContent = resultText;
        this.expanded = false;
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

    /** 结果内容是否有足够多的行，使折叠功能有意义。 */
    isExpandable(): boolean {
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
        const message = this.toolName === "junie_ai"
            ? getTheme().fg("warning", "Calling Junie AI...")
            : getTheme().fg("muted", "(No output)");
        return new Text(message, 2, 0);
    }

    /** 构建折叠的结果预览：前 N 行 + 展开提示。 */
    private buildCollapsedResult(): void {
        const allLines = this.resultContent.split("\n");
        const previewLines = allLines.slice(0, RESULT_PREVIEW_LINES);
        const preview = previewLines
            .map((line) => getTheme().fg("toolOutput", line))
            .join("\n");

        this.addChild(new Text(preview, 2, 0));

        if (allLines.length > RESULT_PREVIEW_LINES) {
            const hint = getTheme().fg(
                "muted",
                `(${keyHint("app.tools.expand", "to expand")})`,
            );
            this.addChild(new Text(hint, 2, 0));
        }
    }
}
