/**
 * Subagent Extension
 *
 * Provides a `delegate` tool for delegating tasks to sub-agents.
 * Supports preset sub-agent configurations: spec-reviewer, plan-reviewer, plan-executor.
 *
 * Each sub-agent runs as an independent pi process via pi RPC mode (--mode rpc),
 * with tool whitelist control, configurable timeout, and structured result return.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSubagentToolDefinition } from "./tool-factory.js";

export default function (pi: ExtensionAPI) {
    pi.registerTool(createSubagentToolDefinition());
}
