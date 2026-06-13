/**
 * TUI rendering for the subagent extension
 *
 * Provides renderCall and renderResult functions used by the tool registration.
 */

import type {AgentToolResult} from "@earendil-works/pi-agent-core";
import {getMarkdownTheme, Theme, ToolRenderContext, ToolRenderResultOptions} from "@earendil-works/pi-coding-agent";
import {Container, Markdown, Text} from "@earendil-works/pi-tui";
import {formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput,} from "./format.js";
import type {SubagentDetail} from "./types.js";

// ---------------------------------------------------------------------------
// Local type for renderCall args (mirrors SubagentParams from tool-definition)
// ---------------------------------------------------------------------------

interface SubagentCallArgs {
  agent: string;
  task: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Call rendering
// ---------------------------------------------------------------------------

/**
 * Render the subagent tool call before execution.
 */
export function renderCall(args: SubagentCallArgs, theme: Theme, ctx: ToolRenderContext): Text {
  const agentName = args.agent || "...";
  const taskText = args.task || "...";

  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName);

  if (ctx.expanded) {
    text += `\n${theme.fg("dim", taskText)}`;
  } else {
    const preview =
      taskText.length > 60 ? `${taskText.slice(0, 60)}...` : taskText;
    text += `\n${theme.fg("dim", preview)}`;
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
): Text | Container {
  const details = result.details as SubagentDetail | undefined;
  if (!details || !details.result) {
    const textPart = result.content[0];
    return new Text(
      textPart && textPart.type === "text" ? textPart.text : "(no output)",
    );
  }

  const r = details.result;
  const mdTheme = getMarkdownTheme();
  const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);

  const container = new Container();
  let header = "";
  if (options.isPartial) {
    header += ` Working...`
  } else {
    header += ` ${icon}`
  }
  if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  container.addChild(new Text(header, 0, 0));
  if (isError && r.errorMessage) {
    container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
  }
  container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
  if (displayItems.length === 0 && !finalOutput) {
    container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    return container;
  }
  if (options.expanded) {
    for (const item of displayItems) {
      if (item.type === "toolCall")
        container.addChild(
          new Text(
            theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
          ),
        );
    }
    if (finalOutput) {
      container.addChild(
        new Markdown(theme.bg("toolSuccessBg", finalOutput.trim()), 0, 0, mdTheme),
      );
    }
  } else {
    const toolCalls = displayItems.filter(item => item.type === "toolCall").slice(-7);
    for (const item of toolCalls) {
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
        ),
      );
    }
    if (finalOutput) {
      const truncated = finalOutput.length > 100
        ? "..." + finalOutput.slice(-100)
        : finalOutput;
      container.addChild(
        new Text(theme.bg("toolSuccessBg", truncated), 0, 0),
      );
    }
  }
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) {
    container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
  }
  return container;
}
