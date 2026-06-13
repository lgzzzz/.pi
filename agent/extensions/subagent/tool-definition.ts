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
 *   }));
 * }
 * ```
 */

import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
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
// TypeBox schemas
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
    agent: Type.String({description: "Name of the agent to invoke"}),
    task: Type.String({description: "Task to delegate to the agent"}),
    cwd: Type.Optional(Type.String({description: "Working directory for the agent process"})),
});

const SubagentParams = Type.Object({
    tasks: Type.Array(TaskItem, {
        description: "Array of {agent, task} for concurrent execution. Use a single element for simple delegation.",
    }),
});

// ---------------------------------------------------------------------------
// Execute function
// ---------------------------------------------------------------------------

async function executeTasks(
    tasks: { agent: string; task: string; cwd?: string }[],
    ctx: { cwd: string },
    agents: AgentConfig[],
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
): Promise<AgentToolResult<SubagentDetails>> {
    if (tasks.length > MAX_PARALLEL_TASKS)
        return {
            content: [
                {
                    type: "text",
                    text: `Too many tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
            ],
            details: { results: [] },
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

    const emitUpdate = () => {
        if (onUpdate) {
            onUpdate({
                content: [],
                details: { results: [...allResults] },
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
                        emitUpdate();
                    }
                },
            );
            allResults[index] = result;
            emitUpdate();
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
                text: `${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
        ],
        details: { results },
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
            "通过 tasks 数组并发执行，传入单个任务即等同于单次调用。",
        ].join(" "),
        promptSnippet: "将任务委派给专用子代理——支持并发执行，单任务即为单次调用",
        promptGuidelines: [
            "当多个子任务相互独立时，使用 tasks 数组并发执行以提高效率。",
            "单个任务直接传入 tasks 单元素数组即可。",
            "使用 subagent 前，调用 subagent 且不传入任何参数，可以获取能使用的子代理的列表",
        ],
        parameters: SubagentParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const discovery = discoverAgents(ctx.cwd);
            const agents = discovery.agents;

            if (!params.tasks || params.tasks.length === 0) {
                const available = formatAgentList(agents);
                return {
                    content: [{
                        type: "text",
                        text: `No tasks provided. Available agents:\n${available}`
                    }],
                    details: { results: [] },
                };
            }

            return executeTasks(params.tasks, ctx, agents, signal, onUpdate);
        },
        renderCall,
        renderResult,
    };
}
