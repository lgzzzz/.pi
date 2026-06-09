/**
 * Junie AI Extension
 *
 * Provides a tool for calling the Junie AI agent via proxychains4.
 * Used for exploring codebases, writing documentation, and creating execution plans.
 *
 * Usage: The AI calls junie_ai tool with a description, and the extension
 * executes: proxychains4 -q junie 'description'
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { buildCollapsedToolPreview } from "./history/helpers.js";

/** Number of lines to show in collapsed preview */
const JUNIE_PREVIEW_LINES = 8;

// ---------------------------------------------------------------------------
// Schema & Types
// ---------------------------------------------------------------------------

const junieAiSchema = Type.Object({
    description: Type.String({
        description:
            "Description of what junie_ai should do. Be specific about the task.",
    }),
});

export type JunieAiToolInput = Static<typeof junieAiSchema>;

/** Details returned by the junie_ai tool execution */
export interface JunieAiToolDetails {
    exitCode?: number | null;
    stderr?: string;
    error?: string;
    status?: string;
}

/** Options for shell command execution used by the junie_ai tool */
export interface JunieAiExecOptions {
    signal?: AbortSignal;
    timeout?: number;
    cwd?: string;
}

/** Result from a shell command execution */
export interface JunieAiExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
}

/** Options for createJunieAiToolDefinition */
export interface JunieAiToolOptions {
    /**
     * Function to execute shell commands.
     * Default uses Node's child_process.exec via sh -c.
     * When used inside a pi extension, pass a wrapper around pi.exec().
     */
    exec?: (command: string, args: string[], options?: JunieAiExecOptions) => Promise<JunieAiExecResult>;
}

// ---------------------------------------------------------------------------
// Tool Definition Factory
// ---------------------------------------------------------------------------

/**
 * Create a ToolDefinition for the junie_ai tool.
 *
 * Follows the same pattern as pi's built-in createReadToolDefinition:
 * - Pure factory function returning a complete ToolDefinition
 * - Accepts optional overrides for shell execution (like ReadToolOptions.operations)
 * - Contains renderCall / renderResult for unified rendering in ToolExecutionComponent
 *
 * Usage in a pi extension:
 *   pi.registerTool(createJunieAiToolDefinition({ exec: (cmd, args, opts) => pi.exec(cmd, args, opts) }));
 *
 * Usage in history viewer (render-only):
 *   const def = createJunieAiToolDefinition();
 *   new ToolExecutionComponent("junie_ai", id, args, {}, def, tui, cwd);
 */
export function createJunieAiToolDefinition(
    options?: JunieAiToolOptions,
): ToolDefinition<typeof junieAiSchema, JunieAiToolDetails> {
    const execFn = options?.exec;

    return {
        name: "junie_ai",
        label: "Junie AI",
        description:
            "Call junie_ai for writing documentation, or creating execution plans." +
            "Pass a clear description of what you want Junie to do, and this tool will execute it and return the result.",
        promptSnippet:
            "Call junie_ai for writing documentation, or creating execution plans.",
        promptGuidelines: [
            "Use junie_ai when you need to write documentation, or create execution plans. Provide a clear, detailed description in the description parameter.",
        ],
        parameters: junieAiSchema,

        renderCall(args, theme, _context) {
            let text = theme.fg("toolTitle", theme.bold("junie_ai"));

            if (typeof args.description === "string" && args.description.trim()) {
                const preview =
                    args.description.length > 120
                        ? args.description.slice(0, 120) + "..."
                        : args.description;
                text += "\n" + theme.fg("muted", preview);
            }

            return new Text(text, 0, 0);
        },

        renderResult(result, options, theme, _context) {
            // Partial / streaming state: show loading indicator
            if (options.isPartial) {
                return new Text(
                    theme.fg("warning", "Calling Junie AI..."),
                    0,
                    0,
                );
            }

            // Error state: show error message
            const details = result.details;
            if (details?.error) {
                return new Text(
                    theme.fg("error", `Error: ${details.error}`),
                    0,
                    0,
                );
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
                JUNIE_PREVIEW_LINES,
                (color, s) => theme.fg(color as any, s),
                `(${keyHint("app.tools.expand", "to expand")})`,
            );
            return new Text(preview, 0, 0);
        },

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const description = params.description;

            if (!description || description.trim() === "") {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: Description cannot be empty",
                        },
                    ],
                    details: { error: "Empty description provided" },
                };
            }

            // Require an exec function to be configured
            if (!execFn) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Error: No exec function configured. When creating the junie_ai tool definition, pass { exec } in JunieAiToolOptions (e.g. createJunieAiToolDefinition({ exec: createPiExecAdapter(pi) })).",
                        },
                    ],
                    details: { error: "No exec function configured" },
                };
            }

            // Execute the proxychains4 junie command
            onUpdate?.({
                content: [{ type: "text", text: `Calling Junie AI...` }],
                details: { status: "executing" },
            });

            try {
                const result = await execFn(
                    "proxychains4",
                    ["-q", "junie", description],
                    { signal, timeout: 3600000, cwd: ctx.cwd },
                );

                if (result.killed) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Error: Command was killed (timeout or cancellation)",
                            },
                        ],
                        details: {
                            error: "timeout",
                            exitCode: result.code,
                        },
                    };
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: result.stdout || "(No output)",
                        },
                    ],
                    details: {
                        exitCode: result.code,
                        stderr: result.stderr,
                    },
                };
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error executing Junie: ${message}`,
                        },
                    ],
                    details: { error: message },
                };
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Extensible exec adapters
// ---------------------------------------------------------------------------

/**
 * Create an exec adapter that wraps a pi ExtensionAPI.exec call.
 *
 * Usage:
 *   const exec = createPiExecAdapter(pi);
 *   const def = createJunieAiToolDefinition({ exec });
 */
export function createPiExecAdapter(
    piExec: (
        command: string,
        args: string[],
        options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
    ) => Promise<{ code?: number; stdout?: string; stderr?: string; killed?: boolean }>,
): (command: string, args: string[], options?: JunieAiExecOptions) => Promise<JunieAiExecResult> {
    return async (command, args, options) => {
        // Build shell command: proxychains4 -q junie '<description>'
        const shellCmd = [command, ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(" ");
        const result = await piExec("sh", ["-c", shellCmd], {
            signal: options?.signal,
            timeout: options?.timeout,
            cwd: options?.cwd,
        });
        return {
            code: result.code ?? null,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            killed: result.killed ?? false,
        };
    };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    const exec = createPiExecAdapter((cmd, args, opts) =>
        pi.exec(cmd, args, opts),
    );

    pi.registerTool(createJunieAiToolDefinition({ exec }));
}
