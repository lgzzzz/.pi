/**
 * 历史扩展 — HistoryViewer
 *
 * 管理滚动状态，并将消息列表渲染到备用屏幕
 * 历史覆盖层的固定高度视口中。
 *
 * 视窗布局（从上到下）：
 *   - 消息显示区域（可滚动）
 *   - 分隔空行（消息显示组件与 footer 之间）
 *   - Footer 行（固定在视窗最后一行，显示 working 指示器）
 *
 * 自动滚动行为：
 *   - 当消息显示区域的最后一行是最新消息时，跟随最新消息（pinnedToBottom = true）
 *   - 向上滚动浏览历史消息时停止跟随
 *   - 滚动回最底部时自动恢复跟随
 *
 * Working 指示器（Footer 组件）：
 *   - 与 pi 内置 Loader 使用相同的旋转帧和间隔（80ms）
 *   - 通过 setInterval 驱动旋转动画，利用 tui.requestRender() 触发重绘
 *   - Footer 行固定在视窗最后一行，无论消息区域滚动情况如何
 *
 * 输入处理：
 *   - 上/下箭头键   → 滚动 SCROLL_LINE_STEP 行
 *   - 左/右箭头键   → 滚动一页（动态视窗高度）
 *   - Ctrl+O         → 切换所有工具结果的展开/折叠状态，
 *                       并保持用户的视口位置不变
 *

 */

import type {Component, TUI} from "@earendil-works/pi-tui";
import {Key, matchesKey} from "@earendil-works/pi-tui";
import {ToolExecutionComponent} from "@earendil-works/pi-coding-agent";
import {SCROLL_LINE_STEP, SPINNER_FRAMES, SPINNER_INTERVAL_MS} from "./constants.js";
import {getTheme} from "./theme.js";

/** 返回当前要渲染的消息/工具 Component 列表的函数。 */
export type MessageListProvider = () => Component[];

/** 返回当前 working 状态的函数。 */
export type WorkingStatusProvider = () => { isWorking: boolean };

/** 返回 footer 行数组（动态高度）的函数，接收当前渲染宽度。 */
export type FooterLinesProvider = (width: number) => string[];

export class HistoryViewer {
    private readonly getMessages: MessageListProvider;
    private readonly getWorkingStatus: WorkingStatusProvider;
    private readonly getFooterLines: FooterLinesProvider | undefined;
    private tui: TUI | null = null;
    private scrollOffset: number = 0;
    private renderWidth: number = 0;
    private renderHeight: number = 0;
    private totalContentLines: number = 0;

    /**
     * 是否固定在底部以跟随最新消息。
     * 初始为 true，打开查看器时立即显示最新的消息。
     * 用户向上滚动后变为 false，滚动回底部时恢复为 true。
     */
    private pinnedToBottom: boolean = true;

    // -- Working 指示器状态 -------------------------------------------------

    /** 当前旋转帧索引。 */
    private spinnerFrame: number = 0;

    /** 旋转动画的 setInterval 句柄，为 null 时动画停止。 */
    private spinnerInterval: ReturnType<typeof setInterval> | null = null;

    /** dispose 是否已调用。 */
    private disposed: boolean = false;

    private expanded: boolean = false;

    constructor(
        getMessages: MessageListProvider,
        getWorkingStatus: WorkingStatusProvider,
        getFooterLines?: FooterLinesProvider,
    ) {
        this.getMessages = getMessages;
        this.getWorkingStatus = getWorkingStatus;
        this.getFooterLines = getFooterLines;
    }

    /**
     * 设置 TUI 引用，使 HistoryViewer 能够通过 requestRender 触发重绘。
     * 在 ctx.ui.custom 回调中调用。
     */
    setTui(tui: TUI): void {
        this.tui = tui;
    }

    /**
     * 停止旋转动画并标记为已释放。
     * 应在覆盖层关闭时调用。
     */
    dispose(): void {
        this.disposed = true;
        this.stopSpinner();
    }

    // -- Working 指示器动画 --------------------------------------------------

    /** 根据当前 working 状态启动或停止旋转动画。 */
    private updateSpinner(): void {
        if (this.disposed) return;

        const status = this.getWorkingStatus();
        if (status.isWorking && !this.spinnerInterval) {
            this.startSpinner();
        } else if (!status.isWorking && this.spinnerInterval) {
            this.stopSpinner();
        }
    }

    /** 启动旋转动画（每 SPINNER_INTERVAL_MS 推进一帧并触发重绘）。 */
    private startSpinner(): void {
        if (this.spinnerInterval) return;
        this.spinnerInterval = setInterval(() => {
            if (this.disposed) {
                this.stopSpinner();
                return;
            }
            this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
            this.tui?.requestRender();
        }, SPINNER_INTERVAL_MS);
    }

    /** 停止旋转动画。 */
    private stopSpinner(): void {
        if (this.spinnerInterval) {
            clearInterval(this.spinnerInterval);
            this.spinnerInterval = null;
        }
    }

    // -- 输入处理 ------------------------------------------------------------

    /**
     * 处理历史覆盖层的键盘输入。
     * @returns 若输入已被处理（导航或切换）则返回 true，否则返回 false。
     */
    handleInput(data: string): boolean {
        if (this.handleKeyboardNavigation(data)) return true;
        return this.handleToolToggle(data);
    }

    /**
     * 处理箭头键导航：
     *   上/下  → 滚动 SCROLL_LINE_STEP 行
     *   左/右  → 滚动一页（renderHeight 行）
     */
    private handleKeyboardNavigation(data: string): boolean {
        const maxScroll = this.computeMaxScroll();
        const pageSize = this.renderHeight > 0 ? this.renderHeight : 1;

        let handled = false;

        if (matchesKey(data, Key.up)) {
            this.scrollOffset = Math.max(
                0,
                this.scrollOffset - SCROLL_LINE_STEP,
            );
            handled = true;
        } else if (matchesKey(data, Key.down)) {
            this.scrollOffset = Math.min(
                maxScroll,
                this.scrollOffset + SCROLL_LINE_STEP,
            );
            handled = true;
        } else if (matchesKey(data, Key.left)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
            handled = true;
        } else if (matchesKey(data, Key.right)) {
            this.scrollOffset = Math.min(maxScroll, this.scrollOffset + pageSize);
            handled = true;
        }

        if (handled) {
            // 根据用户滚动后的位置更新 pinned 状态
            this.pinnedToBottom = this.scrollOffset >= this.computeMaxScroll();
        }

        return handled;
    }

    /**
     * 处理 Ctrl+O：切换所有可展开工具组件的展开/折叠状态。
     *
     * 当 renderWidth 已知时，保持用户的视口位置不变，
     * 使展开或折叠导致布局变化后，用户正在阅读的文本
     * 仍然可见。
     */
    private handleToolToggle(data: string): boolean {
        if (!matchesKey(data, Key.ctrl("o"))) return false;

        const messages = this.getMessages();
        if (messages.length === 0) return true;

        this.toggleAllWithPositionPreservation(messages);

        return true;
    }

    // -- 滚动工具 ------------------------------------------------------------

    /** 按相对增量滚动（正数 = 向下，负数 = 向上）。 */
    scrollBy(delta: number): void {
        const maxScroll = this.computeMaxScroll();

        this.scrollOffset = Math.max(
            0,
            Math.min(maxScroll, this.scrollOffset + delta),
        );
        // 根据用户滚动后的位置更新 pinned 状态
        this.pinnedToBottom = this.scrollOffset >= maxScroll;
    }

    /**
     * 计算 footer 组的总行数。
     * = working 指示器行（如果 active）+ 自定义 footer 行。
     */
    private getFooterHeight(): number {
        const status = this.getWorkingStatus();
        let height = 0;
        if (status.isWorking) height += 2;
        if (this.getFooterLines) {
            const w = this.renderWidth > 0 ? this.renderWidth : 80;
            height += this.getFooterLines(w).length;
        }
        return height;
    }

    /**
     * 计算消息显示区域的最大滚动偏移量。
     * Footer 区域固定在视窗底部，消息区域在 footer 之上
     * 由一个空行分隔。
     */
    private computeMaxScroll(): number {
        if (this.renderHeight <= 0) return 0;
        const footerHeight = this.getFooterHeight();
        const reservedRows = footerHeight > 0 ? footerHeight + 1 : 0; // +1 for separator
        const messageAreaHeight = Math.max(1, this.renderHeight - reservedRows);
        return Math.max(0, this.totalContentLines - messageAreaHeight);
    }

    /**
     * 计算每条消息在渲染输出中起始位置的行偏移量。
     * 在非最后一条消息之后跟一个空行作为分隔。
     */
    private computeMessageOffsets(
        messages: Component[],
        width: number,
    ): number[] {
        const offsets: number[] = [];
        let cumulative = 0;

        for (let i = 0; i < messages.length; i++) {
            offsets.push(cumulative);
            const lines = messages[i].render(width);
            if (lines.length > 0) {
                cumulative += lines.length;
                // 非最后一条消息后添加空行分隔符
                if (i < messages.length - 1) {
                    cumulative += 1;
                }
            }
        }

        return offsets;
    }

    /**
     * 查找用户当前正在查看的消息及其内部行偏移量。
     *
     * 从偏移量列表末尾向前扫描，找到起始偏移量
     * ≤ 当前 scrollOffset 的第一条消息。
     */
    private findViewportAnchor(
        offsets: number[],
    ): { messageIndex: number; innerOffset: number } {
        for (let i = offsets.length - 1; i >= 0; i--) {
            if (offsets[i] <= this.scrollOffset) {
                return {
                    messageIndex: i,
                    innerOffset: this.scrollOffset - offsets[i],
                };
            }
        }
        return {messageIndex: 0, innerOffset: 0};
    }

    // -- 工具结果切换 --------------------------------------------------------

    /** 切换所有可展开工具组件，同时调整滚动位置以保持视口位置不变。 */
    private toggleAllWithPositionPreservation(messages: Component[]): void {
        // 记录用户当前在查看的内容（消息索引 + 内部行偏移量）
        const preOffsets = this.computeMessageOffsets(
            messages,
            this.renderWidth,
        );
        const {messageIndex, innerOffset} =
            this.findViewportAnchor(preOffsets);

        // 统一将所有组件设置为 expanded，避免混合状态
        const changed = this.toggleExpanded(messages);
        if (!changed) return;

        // 在布局变化后恢复视口位置
        const postOffsets = this.computeMessageOffsets(
            messages,
            this.renderWidth,
        );
        this.scrollOffset = Math.max(
            0,
            postOffsets[messageIndex] + innerOffset,
        );
    }

    /**
     * 统一将所有 ToolExecutionComponent 设置为 expanded 状态，
     * 防止一部分已经展开而另一部分未展开的混合状态。
     * 若至少有一个组件被变更则返回 true。
     */
    private toggleExpanded(messages: Component[]): boolean {
        let changed = false;
        this.expanded = !this.expanded
        for (const msg of messages) {
            if (msg instanceof ToolExecutionComponent) {
                msg.setExpanded(this.expanded);
                changed = true;
            }
        }
        return changed;
    }

    // -- 渲染 ----------------------------------------------------------------

    /**
     * 将消息渲染到消息显示区域，并通过固定的分隔行和 footer 行
     * 组合成完整视窗输出。
     *
     * 布局（从上到下）：
     *   - 消息显示区域（可滚动，高度动态调整）
     *   - 分隔空行（消息显示组件与 footer 之间）
     *   - Working 指示器行（仅在 agent 工作时显示）
     *   - 自定义 footer 行（N 行，固定）
     *
     * @param width          终端宽度（列数）
     * @param viewportHeight 动态视窗高度（行数），从 tui.terminal.rows 获取
     */
    render(width: number, viewportHeight: number): string[] {
        this.renderWidth = width;
        this.renderHeight = viewportHeight;

        // 同步旋转动画状态
        this.updateSpinner();

        // 将所有消息渲染为行数组（会更新 totalContentLines）
        const messageLines = this.renderAllMessages(width);

        // 计算 footer 区域高度（working 指示器 + 自定义 footer）
        const footerHeight = this.getFooterHeight();
        // 消息区域与 footer 之间保留一个空行分隔
        const reservedRows = footerHeight > 0 ? footerHeight + 1 : 0;
        const messageAreaHeight = Math.max(1, viewportHeight - reservedRows);

        // 自动滚动：如果固定在底部，跟随最新内容
        // 如果已不在底部，仅将偏移量限制在有效范围内
        const maxScroll = this.computeMaxScroll();
        if (this.pinnedToBottom) {
            this.scrollOffset = maxScroll;
        } else {
            this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
        }
        this.scrollOffset = Math.max(0, this.scrollOffset);

        // 用空行填充，确保可以截取恰好 messageAreaHeight 行
        this.padMessageLines(messageLines, messageAreaHeight);

        // 根据滚动偏移量截取消息区域可见窗口
        const visibleMessageLines = messageLines.slice(
            this.scrollOffset,
            this.scrollOffset + messageAreaHeight,
        );

        // 构建最终输出：消息区域 + 分隔空行 + footer 组
        const output: string[] = [];
        output.push(...visibleMessageLines);

        // 确保消息区域有恰好 messageAreaHeight 行
        while (output.length < messageAreaHeight) {
            output.push("");
        }

        // 消息显示组件与 footer 之间的分隔空行
        if (footerHeight > 0) {
            output.push("");
        }

        // Working 指示器行
        const status = this.getWorkingStatus();
        if (status.isWorking) {
            output.push(this.buildWorkingLine(status));
            if (footerHeight > 0) {
                output.push("");
            }
        }
        // 自定义 footer 行
        if (this.getFooterLines) {
            output.push(...this.getFooterLines(width));
        }

        // 确保恰好 renderHeight 行，防止 overlay 下方内容透出
        while (output.length < viewportHeight) {
            output.push("");
        }

        return output.slice(0, viewportHeight);
    }

    /**
     * 构建 working 指示器行，与 pi 内置 Loader 样式一致。
     * 格式：{spinner} Working...
     * 颜色：spinner 用 accent，文字用 muted
     */
    private buildWorkingLine(
        status: { isWorking: boolean },
    ): string {
        const theme = getTheme();
        const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? "?";
        const spinner = theme.fg("accent", frame);
        const text = theme.fg("muted", "Working...");
        return `${spinner} ${text}`;
    }

    /**
     * 渲染每条消息并收集它们的行。
     * 在连续的消息之间插入一个空行分隔符。
     * 最后一条消息后不添加空行——消息区域与 footer 之间的分隔
     * 由视窗布局中的固定分隔行提供。
     */
    private renderAllMessages(width: number): string[] {
        const lines: string[] = [];
        const messages = this.getMessages();

        for (let i = 0; i < messages.length; i++) {
            const rendered = messages[i].render(width);
            if (rendered.length > 0) {
                lines.push(...rendered);
                // 只在非最后一条消息后添加空行分隔符
            }
        }

        this.totalContentLines = lines.length;
        return lines;
    }

    /**
     * 追加空字符串，直到消息行数组有足够条目支持当前滚动位置。
     * 保证始终可以从 scrollOffset 开始截取恰好 messageAreaHeight 行。
     */
    private padMessageLines(lines: string[], messageAreaHeight: number): void {
        const targetLength = this.scrollOffset + messageAreaHeight;
        while (lines.length < targetLength) {
            lines.push("");
        }
    }

    /** 空操作；满足覆盖层组件接口要求。 */
    invalidate(): void {
    }
}
