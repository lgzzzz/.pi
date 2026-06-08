/**
 * Junie AI Extension
 *
 * Provides a tool for calling the Junie AI agent via proxychains4.
 * Used for exploring codebases, writing documentation, and creating execution plans.
 *
 * Usage: The AI calls junie_ai tool with a description, and the extension
 * executes: proxychains4 -q junie 'description'
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** Number of lines to show in collapsed preview */
const JUNIE_PREVIEW_LINES = 8;

export default function (pi: ExtensionAPI) {
    pi.registerTool({
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
        parameters: Type.Object({
            description: Type.String({
                description:
                    "Description of what junie_ai should do. Be specific about the task.",
            }),
        }),

        renderCall(args, theme, _context) {
            let text = theme.fg("toolTitle", theme.bold("junie_ai"));

            if (
                typeof args.description === "string" &&
                args.description.trim()
            ) {
                const desc =
                    args.description.length > 120
                        ? args.description.slice(0, 120) + "..."
                        : args.description;
                text += "\n" + theme.fg("muted", desc);
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
            const details = result.details as
                | Record<string, unknown>
                | undefined;
            if (details?.error) {
                return new Text(
                    theme.fg("error", `Error: ${details.error}`),
                    0,
                    0,
                );
            }

            // Extract text content from result
            const textContent = (result.content ?? [])
                .filter(
                    (c): c is { type: "text"; text: string } =>
                        c.type === "text",
                )
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
            const lines = textContent.split("\n");
            const previewLines = lines.slice(0, JUNIE_PREVIEW_LINES);
            let text = previewLines
                .map((l) => theme.fg("toolOutput", l))
                .join("\n");
            if (lines.length > JUNIE_PREVIEW_LINES) {
                text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
            }
            return new Text(text, 0, 0);
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

            // Execute the proxychains4 junie command
            const command = `proxychains4 -q junie '${description.replace(/'/g, "'\\''")}'`;

            onUpdate?.({
                content: [{ type: "text", text: `Calling Junie AI...` }],
                details: { status: "executing" },
            });

            try {
                const result = await pi.exec("sh", ["-c", command], {
                    signal,
                    timeout: 3600000,
                    cwd: ctx.cwd,
                });

                if (result.killed) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Error: Command was killed (timeout or cancellation)",
                            },
                        ],
                        details: { error: "timeout", exitCode: result.code },
                    };
                }

                return {
                    content: [
                        { type: "text", text: result.stdout || "(No output)" },
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
    });
}
