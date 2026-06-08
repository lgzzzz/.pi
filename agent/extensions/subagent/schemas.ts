/**
 * 子代理参数模式定义
 *
 * 定义子代理工具的 JSON Schema（TypeBox）参数验证。
 * 这些模式用于验证 LLM 传入的工具调用参数。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// 子模式
// ---------------------------------------------------------------------------

/** 并行/单次任务项 */
const TaskItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({ description: "Task to delegate to the agent" }),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory for the agent process",
        }),
    ),
});

/** 链式任务项（支持 {previous} 占位符） */
const ChainItem = Type.Object({
    agent: Type.String({ description: "Name of the agent to invoke" }),
    task: Type.String({
        description:
            "Task with optional {previous} placeholder for prior output",
    }),
    cwd: Type.Optional(
        Type.String({
            description: "Working directory for the agent process",
        }),
    ),
});

/** 代理搜索范围枚举 */
const AgentScopeSchema = StringEnum(
    ["user", "project", "both"] as const,
    {
        description:
            'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
        default: "user",
    },
);

// ---------------------------------------------------------------------------
// 完整参数模式
// ---------------------------------------------------------------------------

/** 子代理工具的完整参数模式 */
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
            description:
                "Array of {agent, task} for parallel execution",
        }),
    ),
    chain: Type.Optional(
        Type.Array(ChainItem, {
            description:
                "Array of {agent, task} for sequential execution",
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

export { TaskItem, ChainItem, AgentScopeSchema, SubagentParams };