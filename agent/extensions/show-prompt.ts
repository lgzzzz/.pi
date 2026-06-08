/**
 * Extension that shows the current system prompt in a custom UI.
 *
 * Usage: /prompt - Opens a viewer showing the current system prompt.
 *        Press any key to close.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DynamicBorder,
    getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Markdown,
    matchesKey,
    Key,
    Text,
} from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("prompt", {
        description: "Show the current system prompt in a custom viewer",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            // Get the current system prompt
            const systemPrompt = ctx.getSystemPrompt();

            // Create custom UI to display the prompt
            await ctx.ui.custom((tui, theme, _keybindings, done) => {
                const container = new Container();
                const border = new DynamicBorder((s: string) =>
                    theme.fg("accent", s),
                );
                const mdTheme = getMarkdownTheme();

                // Header
                container.addChild(border);
                container.addChild(
                    new Text(
                        theme.fg(
                            "accent",
                            theme.bold(" System Prompt Viewer "),
                        ),
                        1,
                        0,
                    ),
                );
                container.addChild(
                    new Text(
                        theme.fg(
                            "muted",
                            `Length: ${systemPrompt.length} characters`,
                        ),
                        1,
                        0,
                    ),
                );
                container.addChild(new Text("", 1, 0)); // Empty line

                // Content - display system prompt
                if (systemPrompt.trim()) {
                    container.addChild(
                        new Markdown(systemPrompt, 1, 1, mdTheme),
                    );
                } else {
                    container.addChild(
                        new Text(
                            theme.fg("dim", "(No system prompt set)"),
                            1,
                            1,
                        ),
                    );
                }

                container.addChild(new Text("", 1, 0)); // Empty line

                // Footer with instruction
                container.addChild(
                    new Text(
                        theme.fg("dim", "Press any key to close..."),
                        1,
                        0,
                    ),
                );
                container.addChild(border);

                return {
                    render: (width: number) => container.render(width),
                    invalidate: () => container.invalidate(),
                    handleInput: (data: string) => {
                        // Any key press closes the viewer
                        // We still call matchesKey for common keys to be explicit
                        if (
                            matchesKey(data, Key.enter) ||
                            matchesKey(data, Key.escape) ||
                            matchesKey(data, Key.space) ||
                            data.length === 1 // Any printable character
                        ) {
                            done(undefined);
                        }
                    },
                };
            });
        },
    });
}
