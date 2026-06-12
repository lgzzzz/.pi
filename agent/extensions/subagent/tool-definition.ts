/**
 * createSubagentToolDefinition – factory for subagent tool definitions
 *
 * Extensions can import this function to create a custom subagent tool
 * (e.g., with a different name, scope, or concurrency limits) and register
 * it via `pi.registerTool()`.
 *
 * @example
 * ```ts
 * import { createSubagentToolDefinition } from "./subagent/tool-definition.js";
 *
 * export default function (pi: ExtensionAPI) {
 *   pi.registerTool(createSubagentToolDefinition({
 *     name: "my_subagent",
 *     defaultAgentScope: "both",
 *   }));
 * }
 * ```
 */

import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {StringEnum} from "@earendil-works/pi-ai";
import {Type} from "typebox";
import {
    type AgentConfig,
    discoverAgents, formatAgentList,
} from "./agents.js";
import {MAX_CONCURRENCY, MAX_PARALLEL_TASKS} from "./constants.js";
import {getFinalOutput} from "./format.js";
import {renderCall, renderResult} from "./render.js";
import {mapWithConcurrencyLimit, runSingleAgent} from "./runner.js";
import type {OnUpdateCallback, SingleResult, SubagentDetails} from "./types.js";
import type {AgentToolResult} from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// TypeBox schemas (re-exported so callers can reference parameter types)
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
    agent: Type.String({description: "Name of the agent to invoke"}),
    task: Type.String({description: "Task to delegate to the agent"}),
    cwd: Type.Optional(Type.String({description: "Working directory for the agent process"})),
});

const ChainItem = Type.Object({
    agent: Type.String({description: "Name of the agent to invoke"}),
    task: Type.String({description: "Task with optional {previous} placeholder for prior output"}),
    cwd: Type.Optional(Type.String({description: "Working directory for the agent process"})),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
    description:
        'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
    default: "user",
});

const SubagentParams = Type.Object({
    agent: Type.Optional(Type.String({description: "Name of the agent to invoke (for single mode)"})),
    task: Type.Optional(Type.String({description: "Task to delegate (for single mode)"})),
    tasks: Type.Optional(
        Type.Array(TaskItem, {description: "Array of {agent, task} for parallel execution"}),
    ),
    chain: Type.Optional(
        Type.Array(ChainItem, {description: "Array of {agent, task} for sequential execution"}),
    ),
    cwd: Type.Optional(Type.String({description: "Working directory for the agent process (single mode)"})),
});

// ---------------------------------------------------------------------------
// Mode-specific execute functions
// ---------------------------------------------------------------------------

interface ExecuteContext {
    cwd: string;
}

interface ChainStep {
    agent: string;
    task: string;
    cwd?: string;
}

interface ParallelTask {
    agent: string;
    task: string;
    cwd?: string;
}

type MakeDetails = (mode: SubagentDetails["mode"]) => (results: SingleResult[]) => SubagentDetails;

async function executeChainMode(
    chainSteps: ChainStep[],
    ctx: ExecuteContext,
    agents: AgentConfig[],
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: MakeDetails,
): Promise<AgentToolResult<SubagentDetails>> {
    const results: SingleResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < chainSteps.length; i++) {
        const step = chainSteps[i];
        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

        const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                    const allResults = [...results, currentResult];
                    onUpdate({
                        content: partial.content,
                        details: makeDetails("chain")(allResults),
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
            makeDetails("chain"),
        );
        results.push(result);

        const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted";
        if (isError) {
            const errorMsg =
                result.errorMessage ||
                result.stderr ||
                getFinalOutput(result.messages) ||
                "(no output)";
            return {
                content: [
                    {
                        type: "text",
                        text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                    },
                ],
                details: makeDetails("chain")(results),
            };
        }
        previousOutput = getFinalOutput(result.messages);
    }
    return {
        content: [
            {
                type: "text",
                text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
            },
        ],
        details: makeDetails("chain")(results),
    };
}

async function executeParallelMode(
    tasks: ParallelTask[],
    ctx: ExecuteContext,
    agents: AgentConfig[],
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: MakeDetails,
): Promise<AgentToolResult<SubagentDetails>> {
    if (tasks.length > MAX_PARALLEL_TASKS)
        return {
            content: [
                {
                    type: "text",
                    text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
            ],
            details: makeDetails("parallel")([]),
        };

    const allResults: SingleResult[] = new Array(tasks.length);
    for (let i = 0; i < tasks.length; i++) {
        allResults[i] = {
            agent: tasks[i].agent,
            task: tasks[i].task,
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
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
                details: makeDetails("parallel")([...allResults]),
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
                makeDetails("parallel"),
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
        },
    );

    const successCount = results.filter((r) => r.exitCode === 0).length;
    const summaries = results.map((r) => {
        const output = getFinalOutput(r.messages);
        const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
        return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
    });
    return {
        content: [
            {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
        ],
        details: makeDetails("parallel")(results),
    };
}

async function executeSingleMode(
    agentName: string,
    task: string,
    cwd: string | undefined,
    ctx: ExecuteContext,
    agents: AgentConfig[],
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: MakeDetails,
): Promise<AgentToolResult<SubagentDetails>> {
    const result = await runSingleAgent(
        ctx.cwd,
        agents,
        agentName,
        task,
        cwd,
        undefined,
        signal,
        onUpdate,
        makeDetails("single"),
    );
    const isError =
        result.exitCode !== 0 ||
        result.stopReason === "error" ||
        result.stopReason === "aborted";
    if (isError) {
        const errorMsg =
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(no output)";
        return {
            content: [
                {
                    type: "text",
                    text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
                },
            ],
            details: makeDetails("single")([result]),
        };
    }
    return {
        content: [
            {
                type: "text",
                text: getFinalOutput(result.messages) || "(no output)",
            },
        ],
        details: makeDetails("single")([result]),
    };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubagentToolDefinition(): ToolDefinition<typeof SubagentParams, SubagentDetails> {
    return {
        name: "subagent",
        label: "Subagent",
        description: [
            "将任务委派给具有隔离上下文的专用子代理（subagent）。",
            "模式：single（单个代理+任务）、parallel（tasks 并行数组）、chain（顺序执行，支持 {previous} 占位符传递上一步输出）。",
        ].join(" "),
        promptSnippet: "将任务委派给专用子代理——支持单次、并行和链式三种执行模式",
        promptGuidelines: [
            "当多个子任务相互独立时，使用 subagent 的 tasks 模式并行执行以提高效率。",
            "当子任务存在先后依赖时，使用 subagent 的 chain 模式，通过 {previous} 占位符传递上一步的输出结果。",
            "使用 subagent 前，调用subagent且不传入任何的参数，可以获取能使用的子代理的列表",
        ],
        parameters: SubagentParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const discovery = discoverAgents(ctx.cwd);
            const agents = discovery.agents;
            const hasChain = (params.chain?.length ?? 0) > 0;
            const hasTasks = (params.tasks?.length ?? 0) > 0;
            const hasSingle = Boolean(params.agent && params.task);
            const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
            const available = formatAgentList(agents);
            const makeDetails: MakeDetails =
                (mode) =>
                    (results): SubagentDetails => ({
                        mode,
                        projectAgentsDir: discovery.projectAgentsDir,
                        results,
                    });
            const errObj: AgentToolResult<SubagentDetails> = {
                content: [{
                    type: "text",
                    text: `Invalid parameters. Provide exactly one mode.\nAvailable agents:\n${available}`
                }],
                details: makeDetails("single")([]),
            }
            if (modeCount !== 1) {
                return errObj;
            }

            if (hasChain) {
                return executeChainMode(params.chain!, ctx, agents, signal, onUpdate, makeDetails);
            }

            if (hasTasks) {
                return executeParallelMode(params.tasks!, ctx, agents, signal, onUpdate, makeDetails);
            }

            if (hasSingle) {
                return executeSingleMode(
                    params.agent!,
                    params.task!,
                    params.cwd,
                    ctx,
                    agents,
                    signal,
                    onUpdate,
                    makeDetails,
                );
            }
            return errObj;
        },
        renderCall,
        renderResult,
    };
}
