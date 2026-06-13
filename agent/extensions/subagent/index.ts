/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports concurrent execution via `tasks` array.
 * When a single task is given, it acts as a simple delegation.
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
