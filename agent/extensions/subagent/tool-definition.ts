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
import {discoverAgents, formatAgentList} from "./agents.js";
import {getFinalOutput} from "./format.js";
import {renderCall, renderResult} from "./render.js";
import {runSingleAgent} from "./runner.js";
import type {SubagentDetail} from "./types.js";

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubagentToolDefinition(): ToolDefinition<typeof SubagentParams, SubagentDetail> {
  return {
    name: "subagent",
    label: "Subagent",
    description: [
      "将任务委派给具有隔离上下文的专用子代理（subagent）。",
      "需要并发时，可以多次调用 subagent 工具。",
    ].join(" "),
    promptSnippet: "将任务委派给具有隔离上下文的专用子代理",
    promptGuidelines: [
      "每次调用处理一个独立任务。如需并发执行多个任务，请多次调用 subagent。",
      "使用 subagent 前，调用 subagent 且不传入任何参数，可以获取能使用的子代理的列表",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;

      if (!params.agent || !params.task) {
        const available = formatAgentList(agents);
        return {
          content: [{
            type: "text",
            text: `No agent/task provided. Available agents:\n${available}`
          }],
          details: {},
        };
      }

      const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        params.cwd,
        signal,
        onUpdate,
      );

      const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
      if (isError) {
        const errorMsg =
          result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
        return {
          content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
          details: { result },
          isError: true,
        };
      }

      const output = getFinalOutput(result.messages);
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { result },
      };
    },
    renderCall,
    renderResult,
  };
}
