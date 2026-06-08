/**
 * 历史扩展 — HistoryViewer
 *
 * 管理滚动状态，并将消息列表渲染到备用屏幕
 * 历史覆盖层的固定高度视口中。
 *
 * 自动滚动行为：
 *   - 默认跟随最新消息（pinnedToBottom = true）
 *   - 向上滚动浏览历史消息时停止跟随
 *   - 滚动回最底部时自动恢复跟随
 *
 * 输入处理：
 *   - 上/下箭头键   → 滚动 SCROLL_LINE_STEP 行
 *   - 左/右箭头键   → 滚动一页（动态视窗高度）
 *   - Ctrl+O         → 切换所有工具结果的展开/折叠状态，
 *                       并保持用户的视口位置不变
 *
 * 鼠标滚轮滚动由外部处理（参见 mouse.ts），调用 scrollBy()。
 */

import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { SCROLL_LINE_STEP } from "./constants.js";
import { ToolCallComponent } from "./ToolCallComponent.js";

/** 返回当前要渲染的消息/工具 Component 列表的函数。 */
export type MessageListProvider = () => Component[];

export class HistoryViewer {
    private readonly getMessages: MessageListProvider;
    private scrollOffset: number = 0;
    private renderWidth: number = 0;
    private viewportHeight: number = 0;
    private totalContentLines: number = 0;

    /**
     * 是否固定在底部以跟随最新消息。
     * 初始为 true，打开查看器时立即显示最新的消息。
     * 用户向上滚动后变为 false，滚动回底部时恢复为 true。
     */
    private pinnedToBottom: boolean = true;

    constructor(getMessages: MessageListProvider) {
        this.getMessages = getMessages;
    }

    // -- 输入处理 ------------------------------------------------------------

    /** 处理历史覆盖层的键盘输入。 */
    handleInput(data: string): void {
        if (this.handleKeyboardNavigation(data)) return;
        if (this.handleToolToggle(data)) return;
    }

    /**
     * 处理箭头键导航：
     *   上/下  → 滚动 SCROLL_LINE_STEP 行
     *   左/右  → 滚动一页（viewportHeight 行）
     */
    private handleKeyboardNavigation(data: string): boolean {
        const maxScroll = this.computeMaxScroll();
        const pageSize = this.viewportHeight > 0 ? this.viewportHeight : 1;

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

        if (this.renderWidth > 0) {
            this.toggleAllWithPositionPreservation(messages);
        } else {
            this.toggleAll(messages);
        }

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
     * 计算最大滚动偏移量。
     * 内容底部最多可以滚动到视窗底部上方 3 行的位置，
     * 确保底部最多只有三行空白。
     */
    private computeMaxScroll(): number {
        if (this.viewportHeight <= 0) return 0;
        const maxBlankLines = 3;
        return Math.max(0, this.totalContentLines - this.viewportHeight + maxBlankLines);
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
        return { messageIndex: 0, innerOffset: 0 };
    }

    // -- 工具结果切换 --------------------------------------------------------

    /** 切换所有可展开工具组件，同时调整滚动位置以保持视口位置不变。 */
    private toggleAllWithPositionPreservation(messages: Component[]): void {
        // 记录用户当前在查看的内容（消息索引 + 内部行偏移量）
        const preOffsets = this.computeMessageOffsets(
            messages,
            this.renderWidth,
        );
        const { messageIndex, innerOffset } =
            this.findViewportAnchor(preOffsets);

        // 执行所有切换
        const toggled = this.toggleAllExpandable(messages);
        if (!toggled) return;

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
     * 切换列表中所有可展开工具组件的展开/折叠状态。
     * 若至少有一个组件被切换则返回 true。
     */
    private toggleAllExpandable(messages: Component[]): boolean {
        let toggled = false;

        for (const msg of messages) {
            if (msg instanceof ToolCallComponent && msg.isExpandable()) {
                msg.toggleExpand();
                toggled = true;
            } else if (msg instanceof ToolExecutionComponent) {
                this.toggleBuiltInTool(msg);
                toggled = true;
            }
        }

        return toggled;
    }

    /**
     * 切换 ToolExecutionComponent 的展开/折叠状态。
     *
     * ToolExecutionComponent.expanded 在 TypeScript 层面是私有的，
     * 但在运行时可以访问。我们读取当前状态，然后调用
     * setExpanded 来翻转它。
     */
    private toggleBuiltInTool(component: ToolExecutionComponent): void {
        const current = !!(
            component as unknown as { expanded: boolean }
        ).expanded;
        component.setExpanded(!current);
    }

    /** 简单的全部切换，不保持位置（回退路径）。 */
    private toggleAll(messages: Component[]): void {
        for (const msg of messages) {
            if (msg instanceof ToolCallComponent && msg.isExpandable()) {
                msg.toggleExpand();
            } else if (msg instanceof ToolExecutionComponent) {
                this.toggleBuiltInTool(msg);
            }
        }
    }

    // -- 渲染 ----------------------------------------------------------------

    /**
     * 将所有消息渲染到固定行数的视口中。
     *
     * @param width        终端宽度（列数）
     * @param viewportHeight 动态视窗高度（行数），从 tui.terminal.rows 获取
     */
    render(width: number, viewportHeight: number): string[] {
        this.renderWidth = width;
        this.viewportHeight = viewportHeight;

        // 将所有消息渲染为行数组（会更新 totalContentLines）
        const allLines = this.renderAllMessages(width);

        // 自动滚动：如果固定在底部，跟随最新内容
        // 如果已不在底部，仅将偏移量限制在有效范围内
        if (this.pinnedToBottom) {
            this.scrollOffset = this.computeMaxScroll();
        } else {
            this.scrollOffset = Math.min(
                this.scrollOffset,
                this.computeMaxScroll(),
            );
        }
        this.scrollOffset = Math.max(0, this.scrollOffset);

        // 用空行填充，确保我们可以截取恰好 viewportHeight 行
        this.padToViewport(allLines);

        // 根据滚动偏移量截取可见窗口
        return allLines.slice(
            this.scrollOffset,
            this.scrollOffset + viewportHeight,
        );
    }

    /**
     * 渲染每条消息并收集它们的行。
     * 在连续的消息之间插入一个空行分隔符，
     * 最后一条消息后不加空行，避免底部多余空白。
     */
    private renderAllMessages(width: number): string[] {
        const lines: string[] = [];
        const messages = this.getMessages();

        for (let i = 0; i < messages.length; i++) {
            const rendered = messages[i].render(width);
            if (rendered.length > 0) {
                lines.push(...rendered);
                // 只在非最后一条消息后添加空行分隔符
                if (i < messages.length - 1) {
                    lines.push("");
                }
            }
        }

        this.totalContentLines = lines.length;
        return lines;
    }

    /**
     * 追加空字符串，直到行数组有足够条目支持当前滚动位置。
     * 保证始终可以截取恰好 viewportHeight 行，
     * 防止 overlay 界面下方的内容透出。
     */
    private padToViewport(lines: string[]): void {
        const targetLength = this.scrollOffset + this.viewportHeight;
        while (lines.length < targetLength) {
            lines.push("");
        }
    }

    /** 空操作；满足覆盖层组件接口要求。 */
    invalidate(): void {}
}
