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
 *   - Ctrl+O         → 切换所有工具结果的展开/折叠状态
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

    /**
     * 每个组件在最近一次渲染中的起始行索引。
     * componentStartLines[i] = 组件 i 在消息行数组中的第一行。
     * 由 renderAllMessages 在每次渲染时填充。
     */
    private componentStartLines: number[] = [];

    /**
     * 若设置，下一次 render() 将把 scrollOffset 定位到该组件的首行。
     * 在 handleToolToggle 中设置，在 render() 中消费后重置为 null。
     */
    private scrollToComponentIndex: number | null = null;

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
     * 当用户未固定在底部（即正在浏览历史内容）时，
     * 在切换展开状态前先记录当前视窗第一行所属的组件，
     * 以便在重新渲染后将视窗定位回该组件的首行。
     */
    private handleToolToggle(data: string): boolean {
        if (!matchesKey(data, Key.ctrl("o"))) return false;

        const messages = this.getMessages();
        if (messages.length === 0) return true;

        // 仅在用户主动浏览历史（未固定在底部）时锚定当前组件
        if (!this.pinnedToBottom) {
            this.scrollToComponentIndex = this.findComponentAtLine(this.scrollOffset);
        }

        this.toggleExpanded(messages);

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

    // -- 工具结果切换 --------------------------------------------------------

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

        // 若 handleToolToggle 记录了需要锚定的组件，
        // 将 scrollOffset 定位到该组件在本次渲染后的首行。
        // 仅在用户未固定在底部（主动浏览历史）时生效。
        if (this.scrollToComponentIndex !== null && !this.pinnedToBottom) {
            const targetStart = this.componentStartLines[this.scrollToComponentIndex];
            if (targetStart !== undefined) {
                this.scrollOffset = Math.min(targetStart, maxScroll);
            }
            this.scrollToComponentIndex = null;
        }

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
     *
     * 同时填充 componentStartLines，记录每个组件在行数组中的起始行号。
     */
    private renderAllMessages(width: number): string[] {
        const lines: string[] = [];
        const messages = this.getMessages();
        this.componentStartLines = [];

        for (let i = 0; i < messages.length; i++) {
            this.componentStartLines.push(lines.length);
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

    /**
     * 根据行号查找该行属于哪个组件（按 componentStartLines 二分）。
     * 若行号落在所有组件之前则返回 0；
     * 若行号落在所有组件之后（填充行）则返回最后一个组件的索引。
     * 若没有任何组件则返回 -1。
     */
    private findComponentAtLine(lineIndex: number): number {
        if (this.componentStartLines.length === 0) return -1;

        // componentStartLines 按组件顺序严格非递减
        for (let i = this.componentStartLines.length - 1; i >= 0; i--) {
            if (lineIndex >= this.componentStartLines[i]) {
                return i;
            }
        }
        // 行号在所有组件起始行之前（例如 scrollOffset = 0 但第一个组件起始行 > 0），
        // 返回第一个组件
        return 0;
    }

    /** 空操作；满足覆盖层组件接口要求。 */
    invalidate(): void {
    }
}
