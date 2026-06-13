/**
 * Subagent Tool - Delegate a task to a specialized agent
 *
 * Spawns a separate `pi` process for the subagent invocation,
 * giving it an isolated context window.
 *
 * Each call handles a single task. For concurrency, the LLM
 * should call the subagent tool multiple times.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentToolDefinition } from "./tool-definition.js";

// Re-export for other extensions to import
export { createSubagentToolDefinition } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool(createSubagentToolDefinition());
}
