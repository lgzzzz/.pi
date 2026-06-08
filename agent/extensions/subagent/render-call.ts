/**
 * 调用渲染 — 子代理工具调用的 TUI 显示
 *
 * 当 LLM 发起 subagent 工具调用时，渲染器显示调用概要
 * （代理名、任务描述、并行/链式步骤）。
 * 支持折叠和展开两种显示模式。
 */

import { Container, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 共享渲染辅助
// ---------------------------------------------------------------------------

/** 渲染子代理标题行：subagent + 后缀 + 作用域标签 */
function renderHeader(
    container: Container,
    theme: any,
    suffix: string,
    scope: string,
): void {
    container.addChild(
        new Text(
            theme.fg("toolTitle", theme.bold("subagent ")) +
                suffix +
                theme.fg("muted", ` [${scope}]`),
            0,
            0,
        ),
    );
}

/** 截断任务描述（折叠模式下限制最大长度） */
function truncateTask(
    task: string,
    expanded: boolean,
    maxLen: number,
): string {
    if (expanded) return task;
    return task.length > maxLen ? `${task.slice(0, maxLen)}...` : task;
}

/** 渲染 "...+N more" 省略指示 */
function renderMoreIndicator(
    container: Container,
    theme: any,
    count: number,
): void {
    container.addChild(
        new Text(`  ${theme.fg("muted", `... +${count} more`)}`, 0, 0),
    );
}

// ---------------------------------------------------------------------------
// 各模式调用渲染
// ---------------------------------------------------------------------------

/** 渲染链式调用概要 */
export function renderCallChain(
    args: any,
    expanded: boolean,
    theme: any,
): Container {
    const scope: string = args.agentScope ?? "user";
    const container = new Container();

    renderHeader(
        container,
        theme,
        theme.fg("accent", `chain (${args.chain.length} steps)`),
        scope,
    );

    const maxSteps = expanded
        ? args.chain.length
        : Math.min(args.chain.length, 3);
    for (let i = 0; i < maxSteps; i++) {
        const step = args.chain[i];
        const displayTask = truncateTask(step.task, expanded, 40);
        container.addChild(
            new Text(
                "  " +
                    theme.fg("muted", `${i + 1}.`) +
                    " " +
                    theme.fg("accent", step.agent) +
                    theme.fg("dim", ` ${displayTask}`),
                0,
                0,
            ),
        );
    }
    if (!expanded && args.chain.length > 3) {
        renderMoreIndicator(container, theme, args.chain.length - 3);
    }
    return container;
}

/** 渲染并行调用概要 */
export function renderCallParallel(
    args: any,
    expanded: boolean,
    theme: any,
): Container {
    const scope: string = args.agentScope ?? "user";
    const container = new Container();

    renderHeader(
        container,
        theme,
        theme.fg("accent", `parallel (${args.tasks!.length} tasks)`),
        scope,
    );

    const maxTasks = expanded
        ? args.tasks!.length
        : Math.min(args.tasks!.length, 3);
    for (let i = 0; i < maxTasks; i++) {
        const t = args.tasks![i];
        const displayTask = truncateTask(t.task, expanded, 40);
        container.addChild(
            new Text(
                `  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${displayTask}`)}`,
                0,
                0,
            ),
        );
    }
    if (!expanded && args.tasks!.length > 3) {
        renderMoreIndicator(container, theme, args.tasks!.length - 3);
    }
    return container;
}

/** 渲染单次调用概要 */
export function renderCallSingle(
    args: any,
    expanded: boolean,
    theme: any,
): Container {
    const scope: string = args.agentScope ?? "user";
    const agentName: string = args.agent || "...";
    const fullTask: string = args.task || "...";
    const preview = truncateTask(fullTask, expanded, 60);

    const container = new Container();
    renderHeader(container, theme, theme.fg("accent", agentName), scope);
    container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
    return container;
}