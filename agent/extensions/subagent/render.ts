/**
 * TUI rendering for the subagent extension
 *
 * Provides renderCall and renderResult functions used by the tool registration.
 */

import type {AgentToolResult} from "@earendil-works/pi-agent-core";
import {Theme, ToolRenderContext, ToolRenderResultOptions} from "@earendil-works/pi-coding-agent";
import {Text} from "@earendil-works/pi-tui";
import {formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput,} from "./format.js";
import type {SubagentDetail} from "./types.js";

// ---------------------------------------------------------------------------
// Local type for renderCall args (mirrors SubagentParams from tool-definition)
// ---------------------------------------------------------------------------

interface SubagentCallArgs {
  agent?: string;
  task?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Call rendering
// ---------------------------------------------------------------------------

/**
 * Render the subagent tool call before execution.
 */
export function renderCall(args: SubagentCallArgs, theme: Theme, ctx: ToolRenderContext): Text {
  const agentName = args.agent;
  const taskText = args.task;

  let text = theme.fg("toolTitle", theme.bold("subagent"))
  if (agentName) {
    text += theme.fg("accent", " " + agentName);
  }
  if (taskText) {
    text += "\n\n---Task---"
    if (ctx.expanded) {
      text += `\n${theme.fg("muted", taskText.trim())}`;
    } else {
      const preview = taskText.length > 60 ? `${taskText.slice(0, 100)}\n...` : taskText;
      text += `\n${theme.fg("muted", preview.trim())}`;
    }
  }
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/**
 * Render the subagent tool result after execution.
 */
export function renderResult(
  result: AgentToolResult<SubagentDetail | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  _context: ToolRenderContext,
): Text {
  const details = result.details as SubagentDetail | undefined;
  if (!details || !details.result) {
    const textPart = result.content[0];
    return new Text(
      textPart && textPart.type === "text" ? textPart.text : "(no output)",
    );
  }

  const r = details.result;
  const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  let output = "";
  output += `\n---Output---`;
  if (isError && r.stopReason) output += `\n${theme.fg("error", `[${r.stopReason}]`)}`;

  // Error message
  if (isError && r.errorMessage) {
    output += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  }
  if (displayItems.length === 0 && !finalOutput) {
    output += `\n${theme.fg("muted", "(no output)")}`;
    return new Text(output, 0, 0);
  }

  // Tool calls and output
  if (options.expanded) {
    for (const item of displayItems) {
      if (item.type === "toolCall")
        output += `\n${theme.fg("dim", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
    }
    if (finalOutput) {
      output += `\n${theme.fg("muted", finalOutput.trim())}`;
    }
  } else {
    const toolCalls = displayItems.filter(item => item.type === "toolCall").slice(-7);
    for (const item of toolCalls) {
      output += `\n${theme.fg("dim", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
    }
    if (finalOutput) {
      const truncated = finalOutput.length > 100
        ? "...\n" + finalOutput.slice(-100)
        : finalOutput;
      output += `\n${theme.fg("muted", truncated.trim())}`;
    }
  }

  // Usage stats
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) {
    output += `\n\n${theme.fg("muted", usageStr)}`;
  }

  return new Text(output, 0, 0);
}
