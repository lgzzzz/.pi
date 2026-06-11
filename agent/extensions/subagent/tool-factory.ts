import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { buildCollapsedToolPreview } from "../history/helpers.js";

import type { SubagentToolDetails, SubagentToolOptions } from "./types.js";
import { subagentSchema } from "./schema.js";
import { AGENT_PRESETS } from "./presets.js";
import { buildPiArgs, parseResult, PREVIEW_LINES } from "./exec.js";

/**
 * Create a ToolDefinition for the delegate sub-agent tool.
 *
 * Usage in a pi extension:
 *   pi.registerTool(createSubagentToolDefinition({ exec: (cmd, args, opts) => pi.exec(cmd, args, opts) }));
 */
export function createSubagentToolDefinition(
    options?: SubagentToolOptions,
): ToolDefinition<typeof subagentSchema, SubagentToolDetails> {
    const execFn = options?.exec;

    return {
        name: "delegate",
        label: "Delegate",
        description:
            "将任务委派给子代理执行。可用子代理: " +
            Object.entries(AGENT_PRESETS)
                .map(([name, preset]) => `${name} — ${preset.description}`)
                .join("; "),
        promptSnippet:
            "将任务委派给子代理执行。可用: spec-reviewer（审查规范）、plan-reviewer（审查计划）、plan-executor（执行计划）。",
        promptGuidelines: [
            "使用 delegate 工具将规范审查、计划审查、任务执行委派给专门的子代理。agent 参数指定子代理类型，task 参数描述具体任务。",
        ],
        parameters: subagentSchema,

        renderCall(args, theme, _context) {
            let text = theme.fg("toolTitle", theme.bold(`delegate → ${args.agent}`));

            if (typeof args.task === "string" && args.task.trim()) {
                const preview =
                    args.task.length > 120
                        ? args.task.slice(0, 120) + "..."
                        : args.task;
                text += "\n" + theme.fg("muted", preview);
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, options, theme, _context) {
            // Partial / streaming state: show loading indicator
            if (options.isPartial) {
                return new Text(
                    theme.fg("warning", `Delegating to ${result.details?.agent ?? "sub-agent"}...`),
                    0,
                    0,
                );
            }

            // Error state
            const details = result.details;
            if (details?.error) {
                const errorText = details.error === "timeout"
                    ? `Sub-agent "${details.agent}" timed out`
                    : `Sub-agent error: ${details.error}`;
                return new Text(theme.fg("error", errorText), 0, 0);
            }

            // Extract text content from result
            const content = (result.content ?? []) as Array<{
                type: string;
                text?: string;
            }>;
            const textContent = content
                .filter((c) => c.type === "text")
                .map((c) => c.text || "")
                .join("\n");

            // Empty output
            if (!textContent.trim()) {
                return new Text(theme.fg("muted", "(No output)"), 0, 0);
            }

            if (options.expanded) {
                const container = new Container();
                container.addChild(
                    new Markdown(textContent, 0, 0, getMarkdownTheme()),
                );
                container.addChild(
                    new Text(
                        `\n(${keyHint("app.tools.expand", "to collapse")})`,
                        0,
                        0,
                    ),
                );
                return container;
            }

            // Collapsed view: show line-truncated preview
            const preview = buildCollapsedToolPreview(
                textContent,
                PREVIEW_LINES,
                (color, s) => theme.fg(color as any, s),
                `(${keyHint("app.tools.expand", "to expand")})`,
            );
            return new Text(preview, 0, 0);
        },

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const { agent, task, timeout } = params;

            // --- Validation ---
            if (!task || task.trim() === "") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: Task cannot be empty. Please provide a specific task description.",
                        },
                    ],
                    details: {
                        agent,
                        task: "",
                        summary: "",
                        fullOutput: "",
                        exitCode: null,
                        error: "Empty task description",
                    },
                };
            }

            const preset = AGENT_PRESETS[agent];
            if (!preset) {
                const available = Object.keys(AGENT_PRESETS).join(", ");
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Unknown agent "${agent}". Available agents: ${available}`,
                        },
                    ],
                    details: {
                        agent,
                        task: task.trim(),
                        summary: "",
                        fullOutput: "",
                        exitCode: null,
                        error: `Unknown agent: ${agent}`,
                    },
                };
            }

            // --- Require exec function ---
            if (!execFn) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: No exec function configured. When creating the subagent tool definition, pass { exec } in SubagentToolOptions.",
                        },
                    ],
                    details: {
                        agent,
                        task: task.trim(),
                        summary: "",
                        fullOutput: "",
                        exitCode: null,
                        error: "No exec function configured",
                    },
                };
            }

            // --- Build command and execute ---
            const args = buildPiArgs(preset, task.trim());
            const effectiveTimeout = timeout ?? preset.timeout;

            onUpdate?.({
                content: [
                    {
                        type: "text",
                        text: `Delegating to ${preset.label}...`,
                    },
                ],
                details: { agent, task: task.trim(), summary: "", fullOutput: "", exitCode: null, status: "executing" },
            });

            try {
                const result = await execFn("pi", args, {
                    signal,
                    timeout: effectiveTimeout,
                    cwd: ctx.cwd,
                });

                const details = parseResult(agent, task.trim(), result);

                // Build content: show summary with metadata header
                const header = [
                    `## Sub-agent: ${preset.label}`,
                    `- **Exit code:** ${details.exitCode ?? "null"}${details.error ? ` (${details.error})` : ""}`,
                    "",
                ].join("\n");

                const body = details.fullOutput || "(No output)";

                return {
                    content: [
                        {
                            type: "text",
                            text: header + body,
                        },
                    ],
                    details,
                };
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error delegating to ${preset.label}: ${message}`,
                        },
                    ],
                    details: {
                        agent,
                        task: task.trim(),
                        summary: "",
                        fullOutput: "",
                        exitCode: null,
                        error: message,
                    },
                };
            }
        },
    };
}
