/**
 * TUI rendering for the subagent extension
 *
 * Provides renderCall and renderResult functions used by the tool registration.
 */

import type {AgentToolResult} from "@earendil-works/pi-agent-core";
import {getMarkdownTheme, ToolRenderResultOptions} from "@earendil-works/pi-coding-agent";
import {Container, Markdown, Text} from "@earendil-works/pi-tui";
import {COLLAPSED_ITEM_COUNT} from "./constants.js";
import {aggregateUsage, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput,} from "./format.js";
import type {DisplayItem, SingleResult, SubagentDetails} from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function renderDisplayItems(
  items: DisplayItem[],
  expanded: boolean,
  limit: number | undefined,
  theme: { fg: (color: string, text: string) => string },
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg)}\n`;
    }
  }
  return text.trimEnd();
}

// ---------------------------------------------------------------------------
// Single result rendering
// ---------------------------------------------------------------------------

export function renderSingleResult(
  r: SingleResult,
  options: ToolRenderResultOptions,
  theme: any,
  mdTheme: any,
): Text | Container {
  const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const displayItems = getDisplayItems(r.messages);
  const finalOutput = getFinalOutput(r.messages);

  if (options.expanded) {
    const container = new Container();
    let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
    if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
    if (options.isPartial) {
      header += ` Working...`
    }
    container.addChild(new Text(header, 0, 0));
    if (isError && r.errorMessage)
      container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (displayItems.length === 0 && !finalOutput) {
      container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    } else {
      for (const item of displayItems) {
        if (item.type === "toolCall")
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
      }
      if (finalOutput) {
        container.addChild(new Markdown(theme.bg("toolSuccessBg", finalOutput.trim()), 0, 0, mdTheme));
      }
    }
    const usageStr = formatUsageStats(r.usage, r.model);
    if (usageStr) {
      container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
    }
    return container;
  }

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
  if (options.isPartial) {
    text += " Working..."
  }
  if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
  else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
  else {
    text += `\n${renderDisplayItems(displayItems, options.expanded, COLLAPSED_ITEM_COUNT, theme)}`;
    if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  }
  const usageStr = formatUsageStats(r.usage, r.model);
  if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Chain result rendering
// ---------------------------------------------------------------------------

export function renderChainResult(
  details: SubagentDetails,
  options: ToolRenderResultOptions,
  theme: any,
  mdTheme: any,
): Text | Container {
  const successCount = details.results.filter((r) => r.exitCode === 0).length;
  const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

  if (options.expanded) {
    const container = new Container();
    container.addChild(
      new Text(
        icon +
        " " +
        theme.fg("toolTitle", theme.bold("chain ")) +
        theme.fg("accent", `${successCount}/${details.results.length} steps`) + options.isPartial ? " Working..." : "",
        0,
        0,
      ),
    );

    for (const r of details.results) {
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);
      container.addChild(
        new Text(
          `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
          0,
          0,
        ),
      );
      container.addChild(new Text(theme.fg("muted", "Task: ") + "\n" + theme.fg("dim", r.task), 0, 0));
      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
        }
      }

      if (finalOutput) {
        container.addChild(new Markdown(theme.bg("toolSuccessBg", finalOutput.trim()), 0, 0, mdTheme));
      }

      const stepUsage = formatUsageStats(r.usage, r.model);
      if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
    }

    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) {
      container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
    }
    return container;
  }

  let text =
    icon +
    " " +
    theme.fg("toolTitle", theme.bold("chain ")) +
    theme.fg("accent", `${successCount}/${details.results.length} steps`);
  for (const r of details.results) {
    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const displayItems = getDisplayItems(r.messages);
    text += `\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
    if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
    else text += `\n${renderDisplayItems(displayItems, options.expanded, 3, theme)}`;
  }
  const usageStr = formatUsageStats(aggregateUsage(details.results));
  if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
  text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Parallel result rendering
// ---------------------------------------------------------------------------

export function renderParallelResult(
  details: SubagentDetails,
  options: ToolRenderResultOptions,
  theme: any,
  mdTheme: any,
): Text | Container {
  const running = details.results.filter((r) => r.exitCode === -1).length;
  const successCount = details.results.filter((r) => r.exitCode === 0).length;
  const failCount = details.results.filter((r) => r.exitCode > 0).length;
  const isRunning = running > 0;
  const icon = isRunning
    ? theme.fg("warning", "⏳")
    : failCount > 0
      ? theme.fg("warning", "✗")
      : theme.fg("success", "✓");
  const status = isRunning
    ? `${successCount + failCount}/${details.results.length} done, ${running} running`
    : `${successCount}/${details.results.length} tasks`;

  if (options.expanded) {
    const container = new Container();
    container.addChild(
      new Text(
        `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
        0,
        0,
      ),
    );

    for (const r of details.results) {
      const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const displayItems = getDisplayItems(r.messages);
      const finalOutput = getFinalOutput(r.messages);
      container.addChild(
        new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
      );
      container.addChild(new Text(theme.fg("muted", "Task: ") + "\n" + theme.fg("dim", r.task), 0, 0));
      for (const item of displayItems) {
        if (item.type === "toolCall") {
          container.addChild(
            new Text(
              theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
              0,
              0,
            ),
          );
        }
      }

      if (finalOutput) {
        container.addChild(new Markdown(theme.bg("toolSuccessBg", finalOutput.trim()), 0, 0, mdTheme));
      }

      const taskUsage = formatUsageStats(r.usage, r.model);
      if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
    }

    const usageStr = formatUsageStats(aggregateUsage(details.results));
    if (usageStr) {
      container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
    }
    return container;
  }

  // Collapsed view (or still running)
  let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
  for (const r of details.results) {
    const rIcon =
      r.exitCode === -1
        ? theme.fg("warning", "⏳")
        : r.exitCode === 0
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    const displayItems = getDisplayItems(r.messages);
    text += `\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
    if (displayItems.length === 0)
      text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
    else text += `\n${renderDisplayItems(displayItems, options.expanded, 5, theme)}`;
  }
  const usageStr = formatUsageStats(aggregateUsage(details.results));
  if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
  if (!options.expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Mode-specific renderCall functions
// ---------------------------------------------------------------------------

/** Render the subagent call for single mode. */
export function renderSingleCall(args: Record<string, any>, theme: any, _context: any): Text {
  const agentName = args.agent || "...";
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", agentName);
  return new Text(text, 0, 0);
}

/** Render the subagent call for parallel mode. */
export function renderParallelCall(args: Record<string, any>, theme: any, _context: any): Text {
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
  for (const t of args.tasks) {
    text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${t.task}`)}`;
  }
  return new Text(text, 0, 0);
}

/** Render the subagent call for chain mode. */
export function renderChainCall(args: Record<string, any>, theme: any, _context: any): Text {
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) +
    theme.fg("accent", `chain (${args.chain.length} steps)`);
  for (let i = 0; i < args.chain.length; i++) {
    const step = args.chain[i];
    text +=
      "\n  " +
      theme.fg("muted", `${i + 1}.`) +
      " " +
      theme.fg("accent", step.agent);
  }
  return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Public API – used by the tool registration in index.ts
// ---------------------------------------------------------------------------

/**
 * Render the subagent tool call before execution.
 * Dispatches to mode-specific renderers based on the arguments.
 */
export function renderCall(args: Record<string, any>, theme: any, _context: any): Text {
  if (args.chain && args.chain.length > 0) {
    return renderChainCall(args, theme, _context);
  }
  if (args.tasks && args.tasks.length > 0) {
    return renderParallelCall(args, theme, _context);
  }
  return renderSingleCall(args, theme, _context);
}

/**
 * Render the subagent tool result after execution.
 * Dispatches to mode-specific renderers based on the result details.
 */
export function renderResult(
  result: AgentToolResult<SubagentDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: any,
  _context: any,
): Text | Container {
  const details = result.details as SubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    const textPart = result.content[0];
    return new Text(textPart && textPart.type === "text" ? textPart.text : "(no output)", 0, 0);
  }
  const mdTheme = getMarkdownTheme();
  if (details.mode === "single" && details.results.length === 1) {
    return renderSingleResult(details.results[0], options, theme, mdTheme);
  }

  if (details.mode === "chain") {
    return renderChainResult(details, options, theme, mdTheme);
  }

  if (details.mode === "parallel") {
    return renderParallelResult(details, options, theme, mdTheme);
  }

  const textPart = result.content[0];
  return new Text(textPart && textPart.type === "text" ? textPart.text : "(no output)", 0, 0);
}
