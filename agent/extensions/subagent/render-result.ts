/**
 * 结果渲染 — 子代理执行结果的 TUI 显示
 *
 * 将子代理的执行结果（消息、用量、错误信息等）渲染为
 * 折叠或展开的 TUI 容器，支持 single / parallel / chain 三种模式。
 */

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "./types.js";
import { formatToolCall } from "./format.js";
import {
    type SingleResult,
    getFinalOutput,
    getDisplayItems,
    isFailedResult,
} from "../utils/messages.js";
import { formatUsageStats, aggregateUsage } from "../utils/tokens.js";
import { COLLAPSED_ITEM_COUNT } from "../utils/constants.js";

// ---------------------------------------------------------------------------
// 共享渲染辅助
// ---------------------------------------------------------------------------

/** 渲染单个工具调用行（带箭头前缀） */
function renderToolCallLine(
    container: Container,
    item: { name: string; args: Record<string, unknown> },
    theme: any,
): void {
    container.addChild(
        new Text(
            theme.fg("muted", "→ ") +
                formatToolCall(item.name, item.args, theme.fg.bind(theme)),
            0,
            0,
        ),
    );
}

/**
 * 渲染展示项列表。
 *
 * @param expanded    展开模式 — 展示所有工具调用（不显示文本项）
 * @param maxCollapsed 折叠模式下最多显示的项数
 */
function renderDisplayItems(
    container: Container,
    items: ReturnType<typeof getDisplayItems>,
    theme: any,
    expanded: boolean,
    maxCollapsed: number,
): void {
    if (expanded) {
        for (const item of items) {
            if (item.type === "toolCall")
                renderToolCallLine(container, item as any, theme);
        }
        return;
    }

    // 折叠模式：最后 N 项 + 省略指示
    const toShow = items.slice(-maxCollapsed);
    const skipped =
        items.length > maxCollapsed ? items.length - maxCollapsed : 0;

    if (skipped > 0) {
        container.addChild(
            new Text(
                theme.fg("muted", `... ${skipped} earlier items`),
                0,
                0,
            ),
        );
    }
    for (const item of toShow) {
        if (item.type === "text") {
            const preview = item.text
                .split("\n")
                .slice(0, 3)
                .join("\n");
            container.addChild(
                new Text(theme.fg("toolOutput", preview), 0, 0),
            );
        } else {
            renderToolCallLine(container, item as any, theme);
        }
    }
}

/** 渲染 Markdown 输出块（可选带成功背景色） */
function renderMarkdownBlock(
    container: Container,
    output: string,
    theme: any,
    useSuccessBg: boolean,
): void {
    if (!output) return;
    container.addChild(new Spacer(1));
    const mdTheme = getMarkdownTheme();
    const content = useSuccessBg
        ? theme.bg("toolSuccessBg", output.trim())
        : output.trim();
    container.addChild(new Markdown(content, 0, 0, mdTheme));
}

/** 渲染 "(Ctrl+O to expand)" 提示 */
function renderExpandHint(container: Container, theme: any): void {
    container.addChild(
        new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0),
    );
}

/** 渲染单步用量统计行 */
function renderUsageLine(
    container: Container,
    theme: any,
    usage: SingleResult["usage"],
    model?: string,
): void {
    const text = formatUsageStats(usage, model);
    if (!text) return;
    container.addChild(new Text(theme.fg("dim", text), 0, 0));
}

/** 渲染聚合用量统计（带可选前缀，如 "Total: "） */
function renderTotalUsage(
    container: Container,
    theme: any,
    results: SingleResult[],
    prefix = "",
): void {
    const text = formatUsageStats(
        aggregateUsage(results.map((r) => r.usage)),
    );
    if (!text) return;
    container.addChild(new Spacer(1));
    container.addChild(
        new Text(theme.fg("dim", `${prefix}${text}`), 0, 0),
    );
}

// ---------------------------------------------------------------------------
// 单次模式渲染
// ---------------------------------------------------------------------------

export function renderSingleMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const r = details.results[0];
    const container = new Container();
    const isError = isFailedResult(r);
    const icon = isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
    const displayItems = getDisplayItems(r.messages);
    const finalOutput = getFinalOutput(r.messages);

    // 标题行
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
    if (isError && r.stopReason)
        header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    container.addChild(new Text(header, 0, 0));

    // ── 展开模式 ──────────────────────────────────────────
    if (expanded) {
        if (isError && r.errorMessage) {
            container.addChild(
                new Text(
                    theme.fg("error", `Error: ${r.errorMessage}`),
                    0,
                    0,
                ),
            );
        }

        container.addChild(new Spacer(1));
        container.addChild(
            new Text(theme.fg("muted", "─── Output ───"), 0, 0),
        );

        if (displayItems.length === 0 && !finalOutput) {
            container.addChild(
                new Text(theme.fg("muted", "(no output)"), 0, 0),
            );
        } else {
            renderDisplayItems(
                container,
                displayItems,
                theme,
                true,
                COLLAPSED_ITEM_COUNT,
            );
            renderMarkdownBlock(container, finalOutput, theme, true);
        }

        container.addChild(new Spacer(1));
        renderUsageLine(container, theme, r.usage, r.model);
        return container;
    }

    // ── 折叠模式 ──────────────────────────────────────────
    if (isError && r.errorMessage) {
        container.addChild(
            new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
        );
    } else if (displayItems.length === 0) {
        container.addChild(
            new Text(theme.fg("muted", "(no output)"), 0, 0),
        );
    } else {
        renderDisplayItems(
            container,
            displayItems,
            theme,
            false,
            COLLAPSED_ITEM_COUNT,
        );
    }

    renderExpandHint(container, theme);
    renderUsageLine(container, theme, r.usage, r.model);
    return container;
}

// ---------------------------------------------------------------------------
// 链式模式渲染
// ---------------------------------------------------------------------------

export function renderChainMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const container = new Container();
    const successCount = details.results.filter(
        (r) => !isFailedResult(r),
    ).length;
    const icon =
        successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

    // 总标题
    container.addChild(
        new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
            0,
            0,
        ),
    );

    // 逐步渲染
    for (const r of details.results) {
        const rIcon = isFailedResult(r)
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);

        container.addChild(new Spacer(1));
        container.addChild(
            new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
            ),
        );
        container.addChild(
            new Text(
                theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
                0,
                0,
            ),
        );

        if (expanded) {
            renderDisplayItems(container, displayItems, theme, true, 5);
            renderMarkdownBlock(container, finalOutput, theme, true);
        } else {
            if (displayItems.length === 0) {
                container.addChild(
                    new Text(theme.fg("muted", "(no output)"), 0, 0),
                );
            } else {
                renderDisplayItems(container, displayItems, theme, false, 5);
            }
        }

        renderUsageLine(container, theme, r.usage, r.model);
    }

    // 聚合用量
    renderTotalUsage(
        container,
        theme,
        details.results,
        expanded ? "" : "Total: ",
    );

    if (!expanded) renderExpandHint(container, theme);
    return container;
}

// ---------------------------------------------------------------------------
// 并行模式渲染
// ---------------------------------------------------------------------------

export function renderParallelMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const container = new Container();

    const running = details.results.filter((r) => r.exitCode === -1).length;
    const successCount = details.results.filter(
        (r) => !isFailedResult(r),
    ).length;
    const failCount = details.results.filter((r) => isFailedResult(r)).length;
    const isRunning = running > 0;

    // 图标与状态文本
    const icon = isRunning
        ? theme.fg("warning", "⏳")
        : failCount > 0
          ? theme.fg("warning", "◐")
          : theme.fg("success", "✓");
    const status = isRunning
        ? `${successCount + failCount}/${details.results.length} done, ${running} running`
        : `${successCount}/${details.results.length} tasks`;

    // 总标题
    container.addChild(
        new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
            0,
            0,
        ),
    );

    // ── 展开模式（且非运行中）──────────────────────────────────────
    if (expanded && !isRunning) {
        for (const r of details.results) {
            const rIcon = isFailedResult(r)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
                new Text(
                    `${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
                    0,
                    0,
                ),
            );
            container.addChild(
                new Text(
                    theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
                    0,
                    0,
                ),
            );

            renderDisplayItems(container, displayItems, theme, true, 5);
            renderMarkdownBlock(container, finalOutput, theme, false);
            renderUsageLine(container, theme, r.usage, r.model);
        }

        renderTotalUsage(container, theme, details.results, "Total: ");
        return container;
    }

    // ── 折叠模式 或 运行中 ────────────────────────────────────────────
    for (const r of details.results) {
        const rIcon =
            r.exitCode === -1
                ? theme.fg("warning", "⏳")
                : isFailedResult(r)
                  ? theme.fg("error", "✗")
                  : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);

        container.addChild(new Spacer(1));
        container.addChild(
            new Text(
                `${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
            ),
        );

        if (displayItems.length === 0) {
            container.addChild(
                new Text(
                    theme.fg(
                        "muted",
                        r.exitCode === -1 ? "(running...)" : "(no output)",
                    ),
                    0,
                    0,
                ),
            );
        } else {
            renderDisplayItems(container, displayItems, theme, false, 5);
        }
    }

    // 聚合用量（仅非运行中）
    if (!isRunning) {
        renderTotalUsage(container, theme, details.results, "Total: ");
    }

    if (!expanded) renderExpandHint(container, theme);
    return container;
}