/**
 * Subagent 工具 — 将任务委派给专业子代理
 *
 * 为每种子代理调用启动独立的 pi 进程，拥有隔离的上下文窗口。
 *
 * 支持三种模式：
 *   - Single:  { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain:   { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * 使用 JSON 模式从子代理捕获结构化输出。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentScope, AgentConfig } from "./agents.js";
import { discoverAgents } from "./agents.js";
import type { SubagentDetails } from "./types.js";
import { SubagentParams } from "./schemas.js";
import { executeSingle, executeParallel, executeChain } from "./execute.js";
import {
    renderCallSingle,
    renderCallParallel,
    renderCallChain,
} from "./render-call.js";
import {
    renderSingleMode,
    renderChainMode,
    renderParallelMode,
} from "./render-result.js";
import type { SingleResult } from "../utils/messages.js";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 扩展入口
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
            // ── 1. 发现可用代理 ──────────────────────────────────────
            const agentScope: AgentScope = params.agentScope ?? "user";
            const discovery = discoverAgents(ctx.cwd, agentScope);
            const agents = discovery.agents;
            const confirmProjectAgents =
                params.confirmProjectAgents ?? true;

            // ── 2. 判断执行模式 ──────────────────────────────────────
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

            // 参数必须指定恰好一种模式
            if (modeCount !== 1) {
                const available =
                    agents
                        .map((a) => `${a.name} (${a.source})`)
                        .join(", ") || "none";
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

            // ── 3. 项目代理确认 ────────────────────────────────────────
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
                    .filter(
                        (a): a is AgentConfig => a?.source === "project",
                    );

                if (projectAgentsRequested.length > 0) {
                    const names = projectAgentsRequested
                        .map((a) => a.name)
                        .join(", ");
                    const dir = discovery.projectAgentsDir ?? "(unknown)";
                    const ok = await ctx.ui.confirm(
                        "Run project-local agents?",
                        `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                    );
                    if (!ok) {
                        const fallbackMode = hasChain
                            ? "chain"
                            : hasTasks
                              ? "parallel"
                              : "single";
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Canceled: project-local agents not approved.",
                                },
                            ],
                            details: makeDetails(fallbackMode)([]),
                        };
                    }
                }
            }

            // ── 4. 分发到对应执行器 ────────────────────────────────────
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
                agents
                    .map((a) => `${a.name} (${a.source})`)
                    .join(", ") || "none";
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
            const details = result.details as
                | SubagentDetails
                | undefined;
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