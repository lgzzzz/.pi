/**
 * Subagent Extension
 *
 * Provides a `delegate` tool for delegating tasks to sub-agents.
 * Supports preset sub-agent configurations: spec-reviewer, plan-reviewer, plan-executor.
 *
 * Each sub-agent runs as an independent pi process via pi.exec(),
 * with tool whitelist control, configurable timeout, and structured result return.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiExecAdapter } from "./exec.js";
import { createSubagentToolDefinition } from "./tool-factory.js";

export default function (pi: ExtensionAPI) {
    const exec = createPiExecAdapter((cmd, args, opts) =>
        pi.exec(cmd, args, opts),
    );

    pi.registerTool(createSubagentToolDefinition({ exec }));
}
