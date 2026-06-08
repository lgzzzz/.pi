/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

// ---- Shared utilities ----
import {
    aggregateUsage,
    formatUsageStats,
    type UsageStats,
} from "../utils/tokens.js";

import {
    getFinalOutput,
    getDisplayItems,
    isFailedResult,
    getResultOutput,
    type SingleResult,
} from "../utils/messages.js";
import { mapWithConcurrencyLimit } from "../utils/async.js";
import { getPiInvocation, writePromptToTempFile } from "../utils/process.js";
import {
    MAX_PARALLEL_TASKS,
    MAX_CONCURRENCY,
    COLLAPSED_ITEM_COUNT,
} from "../utils/constants.js";

// ---------------------------------------------------------------------------
// Subagent-specific types
// ---------------------------------------------------------------------------

interface SubagentDetails {
    mode: "single" | "parallel" | "chain";
    agentScope: AgentScope;
    projectAgentsDir: string | null;
    results: SingleResult[];
}

// ---------------------------------------------------------------------------
// Tool-call renderer (subagent-specific rendering logic)
// ---------------------------------------------------------------------------

function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: any, text: string) => string,
): string {
    const shortenPath = (p: string) => {
        const home = os.homedir();
        return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    };

    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview =
                command.length > 60 ? `${command.slice(0, 60)}...` : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }
        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine =
                    limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg(
                    "warning",
                    `:${startLine}${endLine ? `-${endLine}` : ""}`,
                );
            }
            return themeFg("muted", "read ") + text;
        }
        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;
            let text = themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }
        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return (
                themeFg("muted", "edit ") +
                themeFg("accent", shortenPath(rawPath))
            );
        }
        case "ls": {
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "ls ") +
                themeFg("accent", shortenPath(rawPath))
            );
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "find ") +
                themeFg("accent", pattern) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }
        default: {
            const argsStr = JSON.stringify(args);
            const preview =
                argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Subagent invocation
// ---------------------------------------------------------------------------

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
    const agent = agents.find((a) => a.name === agentName);

    if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
            agent: agentName,
            agentSource: "unknown",
            task,
            exitCode: 1,
            messages: [],
            stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cost: 0,
                contextTokens: 0,
            },
            step,
        };
    }

    const args: string[] = ["--mode", "json", "-p"];
    if (agent.model) args.push("--model", agent.model);
    if (agent.tools && agent.tools.length > 0)
        args.push("--tools", agent.tools.join(","));

    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const currentResult: SingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, contextTokens: 0 },
        model: agent.model,
        step,
    };

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [
                    {
                        type: "text",
                        text:
                            getFinalOutput(currentResult.messages) ||
                            "(running...)",
                    },
                ],
                details: makeDetails([currentResult]),
            });
        }
    };

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(
                agent.name,
                agent.systemPrompt,
            );
            tmpPromptDir = tmp.dir;
            tmpPromptPath = tmp.filePath;
            args.push("--append-system-prompt", tmpPromptPath);
        }

        args.push(`Task: ${task}`);
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let buffer = "";

            const processLine = (line: string) => {
                if (!line.trim()) return;
                let event: any;
                try {
                    event = JSON.parse(line);
                } catch {
                    return;
                }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    currentResult.messages.push(msg);

                    if (msg.role === "assistant") {
                        const usage = msg.usage;
                        if (usage) {
                            currentResult.usage.input += usage.input || 0;
                            currentResult.usage.output += usage.output || 0;
                            currentResult.usage.cacheRead +=
                                usage.cacheRead || 0;
                            currentResult.usage.cost =
                                (currentResult.usage.cost ?? 0) +
                                (usage.cost?.total || 0);
                            currentResult.usage.contextTokens =
                                usage.totalTokens || 0;
                        }
                        if (!currentResult.model && msg.model)
                            currentResult.model = msg.model;
                        if (msg.stopReason)
                            currentResult.stopReason = msg.stopReason;
                        if (msg.errorMessage)
                            currentResult.errorMessage = msg.errorMessage;
                    }
                    emitUpdate();
                }

                if (event.type === "tool_result_end" && event.message) {
                    currentResult.messages.push(event.message as Message);
                    emitUpdate();
                }
            };

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr.on("data", (data) => {
                currentResult.stderr += data.toString();
            });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                resolve(code ?? 0);
            });

            proc.on("error", () => {
                resolve(1);
            });

            if (signal) {
                const killProc = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted) killProc();
                else signal.addEventListener("abort", killProc, { once: true });
            }
        });

        currentResult.exitCode = exitCode;
        if (wasAborted) throw new Error("Subagent was aborted");
        return currentResult;
    } finally {
        if (tmpPromptPath)
            try {
                fs.unlinkSync(tmpPromptPath);
            } catch {
                /* ignore */
            }
        if (tmpPromptDir)
            try {
                fs.rmdirSync(tmpPromptDir);
            } catch {
                /* ignore */
            }
    }
}

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(
        Type.String({ description: "Working directory for the agent process" }),
    ),
});

const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({
        description:
            "Task with optional {previous} placeholder for prior output",
    }),
    cwd: Type.Optional(
        Type.String({ description: "Working directory for the agent process" }),
    ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
    description:
        'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: "user",
});

const SubagentParams = Type.Object({
    agent: Type.Optional(
        Type.String({
            description: "Name of the agent to invoke (for single mode)",
        }),
    ),
    task: Type.Optional(
        Type.String({ description: "Task to delegate (for single mode)" }),
    ),
    tasks: Type.Optional(
        Type.Array(TaskItem, {
            description: "Array of {agent, task} for parallel execution",
        }),
    ),
    chain: Type.Optional(
        Type.Array(ChainItem, {
            description: "Array of {agent, task} for sequential execution",
        }),
    ),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
        Type.Boolean({
            description:
                "Prompt before running project-local agents. Default: true.",
            default: true,
        }),
    ),
    cwd: Type.Optional(
        Type.String({
            description:
                "Working directory for the agent process (single mode)",
        }),
    ),
});

// ---------------------------------------------------------------------------
// Shared result-rendering helpers
// ---------------------------------------------------------------------------

/** Render a single tool-call line into the container. */
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
 * Render display items into the container.
 *
 * - expanded=true:  renders all tool-call lines (no text items)
 * - expanded=false: renders last `maxCollapsed` items (text previews +
 *   tool calls) with a skip-count indicator when items exceed the limit
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
            if (item.type === "toolCall") {
                renderToolCallLine(container, item as any, theme);
            }
        }
        return;
    }

    // Collapsed: last N items with skip indicator
    const toShow = items.slice(-maxCollapsed);
    const skipped =
        items.length > maxCollapsed ? items.length - maxCollapsed : 0;
    if (skipped > 0) {
        container.addChild(
            new Text(theme.fg("muted", `... ${skipped} earlier items`), 0, 0),
        );
    }
    for (const item of toShow) {
        if (item.type === "text") {
            const preview = item.text.split("\n").slice(0, 3).join("\n");
            container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
        } else {
            renderToolCallLine(container, item as any, theme);
        }
    }
}

/** Render final output as a Markdown block, optionally with success background. */
function renderMarkdownBlock(
    container: Container,
    output: string,
    theme: any,
    mdTheme: any,
    useBg: boolean,
): void {
    if (!output) return;
    container.addChild(new Spacer(1));
    const content = useBg
        ? theme.bg("toolSuccessBg", output.trim())
        : output.trim();
    container.addChild(new Markdown(content, 0, 0, mdTheme));
}

/** Render the "(Ctrl+O to expand)" hint line. */
function renderExpandHint(container: Container, theme: any): void {
    container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
}

// ---------------------------------------------------------------------------
// Shared call-rendering helpers
// ---------------------------------------------------------------------------

/** Render the common "subagent " + suffix + scope header line. */
function renderSubagentHeader(
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

/** Return task text truncated in collapsed mode. */
function truncateTask(task: string, expanded: boolean, maxLen: number): string {
    if (expanded) return task;
    return task.length > maxLen ? `${task.slice(0, maxLen)}...` : task;
}

/** Render the "...+N more" skipped-items indicator. */
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
// Mode-specific call-render functions
// ---------------------------------------------------------------------------

function renderCallChain(args: any, expanded: boolean, theme: any): Container {
    const scope: string = args.agentScope ?? "user";
    const container = new Container();
    renderSubagentHeader(
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

function renderCallParallel(
    args: any,
    expanded: boolean,
    theme: any,
): Container {
    const scope: string = args.agentScope ?? "user";
    const container = new Container();
    renderSubagentHeader(
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

function renderCallSingle(args: any, expanded: boolean, theme: any): Container {
    const scope: string = args.agentScope ?? "user";
    const agentName: string = args.agent || "...";
    const fullTask: string = args.task || "...";
    const preview = truncateTask(fullTask, expanded, 60);
    const container = new Container();
    renderSubagentHeader(
        container,
        theme,
        theme.fg("accent", agentName),
        scope,
    );
    container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
    return container;
}

// ---------------------------------------------------------------------------
// Mode-specific execute functions
// ---------------------------------------------------------------------------

async function executeChain(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const results: SingleResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < params.chain.length; i++) {
        const step = params.chain[i];
        const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
        );

        const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                  const currentResult = partial.details?.results[0];
                  if (currentResult) {
                      const allResults = [...results, currentResult];
                      onUpdate({
                          content: partial.content,
                          details: makeDetails(allResults),
                      });
                  }
              }
            : undefined;

        const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails,
        );
        results.push(result);

        if (isFailedResult(result)) {
            const errorMsg = getResultOutput(result);
            return {
                content: [
                    {
                        type: "text",
                        text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                    },
                ],
                details: makeDetails(results),
                isError: true,
            };
        }
        previousOutput = getFinalOutput(result.messages);
    }
    return {
        content: [
            {
                type: "text",
                text:
                    getFinalOutput(results[results.length - 1].messages) ||
                    "(no output)",
            },
        ],
        details: makeDetails(results),
    };
}

async function executeParallel(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const tasks = params.tasks as {
        agent: string;
        task: string;
        cwd?: string;
    }[];
    if (tasks.length > MAX_PARALLEL_TASKS)
        return {
            content: [
                {
                    type: "text",
                    text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
            ],
            details: makeDetails([]),
        };

    const allResults: SingleResult[] = new Array(tasks.length);

    for (let i = 0; i < tasks.length; i++) {
        allResults[i] = {
            agent: tasks[i].agent,
            agentSource: "unknown",
            task: tasks[i].task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cost: 0,
                contextTokens: 0,
            },
        };
    }

    const emitParallelUpdate = () => {
        if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
                content: [
                    {
                        type: "text",
                        text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                    },
                ],
                details: makeDetails([...allResults]),
            });
        }
    };

    const results = await mapWithConcurrencyLimit(
        tasks,
        MAX_CONCURRENCY,
        async (t, index) => {
            const result = await runSingleAgent(
                ctx.cwd,
                agents,
                t.agent,
                t.task,
                t.cwd,
                undefined,
                signal,
                (partial) => {
                    if (partial.details?.results[0]) {
                        allResults[index] = partial.details.results[0];
                        emitParallelUpdate();
                    }
                },
                makeDetails,
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
        },
    );

    const successCount = results.filter((r) => !isFailedResult(r)).length;
    const summaries = results.map((r) => {
        const output = getFinalOutput(r.messages);
        const preview =
            output.slice(0, 100) + (output.length > 100 ? "..." : "");
        const status = isFailedResult(r) ? "failed" : "completed";
        return `[${r.agent}] ${status}: ${preview || "(no output)"}`;
    });
    return {
        content: [
            {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
        ],
        details: makeDetails(results),
    };
}

async function executeSingle(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        params.cwd,
        undefined,
        signal,
        onUpdate,
        makeDetails,
    );
    if (isFailedResult(result)) {
        const errorMsg = getResultOutput(result);
        return {
            content: [
                {
                    type: "text",
                    text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
                },
            ],
            details: makeDetails([result]),
            isError: true,
        };
    }
    return {
        content: [
            {
                type: "text",
                text: getFinalOutput(result.messages) || "(no output)",
            },
        ],
        details: makeDetails([result]),
    };
}

// ---------------------------------------------------------------------------
// Mode-specific result-render functions
// ---------------------------------------------------------------------------

function renderSingleMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const r = details.results[0];
    const container = new Container();
    const isError = isFailedResult(r);
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = getDisplayItems(r.messages);
    const finalOutput = getFinalOutput(r.messages);

    // Header
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
    if (isError && r.stopReason)
        header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    container.addChild(new Text(header, 0, 0));

    if (expanded) {
        if (isError && r.errorMessage)
            container.addChild(
                new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
            );

        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
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
            renderMarkdownBlock(
                container,
                finalOutput,
                theme,
                getMarkdownTheme(),
                true,
            );
        }

        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
    }

    // Collapsed
    if (isError && r.errorMessage) {
        container.addChild(
            new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
        );
    } else if (displayItems.length === 0) {
        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
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

    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) {
        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    return container;
}

function renderChainMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const mdTheme = getMarkdownTheme();
    const successCount = details.results.filter(
        (r) => !isFailedResult(r),
    ).length;
    const icon =
        successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");
    const container = new Container();

    // Mode header
    container.addChild(
        new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
            0,
            0,
        ),
    );

    // Per-step results
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

        if (!expanded) {
            if (displayItems.length === 0) {
                container.addChild(
                    new Text(theme.fg("muted", "(no output)"), 0, 0),
                );
            } else {
                renderDisplayItems(container, displayItems, theme, false, 5);
            }
        } else {
            renderDisplayItems(container, displayItems, theme, true, 5);
            renderMarkdownBlock(container, finalOutput, theme, mdTheme, true);
        }

        const stepUsage = formatUsageStats(r.usage, r.model);
        if (stepUsage)
            container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
    }

    // Aggregated usage (collapsed uses "Total: " prefix)
    const totalUsage = formatUsageStats(
        aggregateUsage(details.results.map((r) => r.usage)),
    );
    if (totalUsage) {
        container.addChild(new Spacer(1));
        container.addChild(
            new Text(
                theme.fg("dim", `${expanded ? "" : "Total: "}${totalUsage}`),
                0,
                0,
            ),
        );
    }

    if (!expanded) {
        renderExpandHint(container, theme);
    }

    return container;
}

function renderParallelMode(
    details: SubagentDetails,
    expanded: boolean,
    theme: any,
): Container {
    const mdTheme = getMarkdownTheme();
    const running = details.results.filter((r) => r.exitCode === -1).length;
    const successCount = details.results.filter(
        (r) => !isFailedResult(r),
    ).length;
    const failCount = details.results.filter((r) => isFailedResult(r)).length;
    const isRunning = running > 0;
    const icon = isRunning
        ? theme.fg("warning", "⏳")
        : failCount > 0
          ? theme.fg("warning", "◐")
          : theme.fg("success", "✓");
    const status = isRunning
        ? `${successCount + failCount}/${details.results.length} done, ${running} running`
        : `${successCount}/${details.results.length} tasks`;

    // Expanded (only when not running)
    if (expanded && !isRunning) {
        const container = new Container();
        container.addChild(
            new Text(
                `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
                0,
                0,
            ),
        );

        for (const r of details.results) {
            const rIcon = isFailedResult(r)
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);

            container.addChild(new Spacer(1));
            container.addChild(
                new Text(
                    `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
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
            renderMarkdownBlock(container, finalOutput, theme, mdTheme, false);

            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage)
                container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
        }

        const totalUsage = formatUsageStats(
            aggregateUsage(details.results.map((r) => r.usage)),
        );
        if (totalUsage) {
            container.addChild(new Spacer(1));
            container.addChild(
                new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0),
            );
        }
        return container;
    }

    // Collapsed (or still running)
    const container = new Container();
    container.addChild(
        new Text(
            `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
            0,
            0,
        ),
    );

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

    if (!isRunning) {
        const totalUsage = formatUsageStats(
            aggregateUsage(details.results.map((r) => r.usage)),
        );
        if (totalUsage) {
            container.addChild(new Spacer(1));
            container.addChild(
                new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0),
            );
        }
    }

    if (!expanded) {
        renderExpandHint(container, theme);
    }

    return container;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: [
            "Delegate tasks to specialized subagents with isolated context.",
            "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
            'Default agent scope is "user" (from ~/.pi/agent/agents).',
            'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
        ].join(" "),
        promptSnippet:
            "Delegate tasks to specialized subagents with isolated context.",
        parameters: SubagentParams,

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const agentScope: AgentScope = params.agentScope ?? "user";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;
            const confirmProjectAgents = params.confirmProjectAgents ?? true;

            const hasChain = (params.chain?.length ?? 0) > 0;
            const hasTasks = (params.tasks?.length ?? 0) > 0;
            const hasSingle = Boolean(params.agent && params.task);
            const modeCount =
                Number(hasChain) + Number(hasTasks) + Number(hasSingle);

            const makeDetails =
                (mode: "single" | "parallel" | "chain") =>
                (results: SingleResult[]): SubagentDetails => ({
                    mode,
                    agentScope,
                    projectAgentsDir: discovery.projectAgentsDir,
                    results,
                });

            if (modeCount !== 1) {
                const available =
                    agents.map((a) => `${a.name} (${a.source})`).join(", ") ||
                    "none";
                return {
                    content: [
                        {
                            type: "text",
                            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                        },
                    ],
                    details: makeDetails("single")([]),
                };
            }

            if (
                (agentScope === "project" || agentScope === "both") &&
                confirmProjectAgents &&
                ctx.hasUI
            ) {
                const requestedAgentNames = new Set<string>();
                if (params.chain)
                    for (const step of params.chain)
                        requestedAgentNames.add(step.agent);
                if (params.tasks)
                    for (const t of params.tasks)
                        requestedAgentNames.add(t.agent);
                if (params.agent) requestedAgentNames.add(params.agent);

                const projectAgentsRequested = Array.from(requestedAgentNames)
                    .map((name) => agents.find((a) => a.name === name))
                    .filter((a): a is AgentConfig => a?.source === "project");

                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested
                        .map((a) => a.name)
                        .join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok)
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Canceled: project-local agents not approved.",
                                },
                            ],
                            details: makeDetails(
                                hasChain
                                    ? "chain"
                                    : hasTasks
                                      ? "parallel"
                                      : "single",
                            )([]),
                        };
                }
            }

            if (params.chain && params.chain.length > 0)
                return executeChain(
                    params,
                    signal,
                    onUpdate,
                    ctx,
                    agents,
                    makeDetails("chain"),
                );
            if (params.tasks && params.tasks.length > 0)
                return executeParallel(
                    params,
                    signal,
                    onUpdate,
                    ctx,
                    agents,
                    makeDetails("parallel"),
                );
            if (params.agent && params.task)
                return executeSingle(
                    params,
                    signal,
                    onUpdate,
                    ctx,
                    agents,
                    makeDetails("single"),
                );

            const available =
                agents.map((a) => `${a.name} (${a.source})`).join(", ") ||
                "none";
            return {
                content: [
                    {
                        type: "text",
                        text: `Invalid parameters. Available agents: ${available}`,
                    },
                ],
                details: makeDetails("single")([]),
            };
        },

        renderCall(args, theme, context) {
            const expanded = context?.expanded ?? false;
            if (args.chain && args.chain.length > 0)
                return renderCallChain(args, expanded, theme);
            if (args.tasks && args.tasks.length > 0)
                return renderCallParallel(args, expanded, theme);
            return renderCallSingle(args, expanded, theme);
        },

        renderResult(result, { expanded }, theme, _context) {
            const details = result.details as SubagentDetails | undefined;
            if (!details || details.results.length === 0) {
                const text = result.content[0];
                return new Text(
                    text?.type === "text" ? text.text : "(no output)",
                    0,
                    0,
                );
            }

            switch (details.mode) {
                case "single":
                    return renderSingleMode(details, expanded, theme);
                case "chain":
                    return renderChainMode(details, expanded, theme);
                case "parallel":
                    return renderParallelMode(details, expanded, theme);
                default: {
                    const text = result.content[0];
                    return new Text(
                        text?.type === "text" ? text.text : "(no output)",
                        0,
                        0,
                    );
                }
            }
        },
    });
}
