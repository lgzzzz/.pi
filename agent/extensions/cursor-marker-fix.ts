/**
 * Cursor Marker Fix Extension
 *
 * Fixes the issue where CURSOR_MARKER is not emitted when the editor is in autocomplete mode.
 * This is important for IME (Input Method Editor) support on CJK terminals.
 *
 * Usage: /cursor-marker-fix to apply the fix, /cursor-marker-unfix to restore the default editor.
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
    CURSOR_MARKER,
    type EditorTheme,
    type TUI,
} from "@earendil-works/pi-tui";

/**
 * Editor that always emits CURSOR_MARKER when focused, even during autocomplete.
 * This enables proper IME cursor positioning for CJK input in all situations.
 *
 * The base Editor class only emits CURSOR_MARKER when `autocompleteState` is null.
 * This class modifies the rendered output to inject the marker regardless of autocomplete state.
 */
class CursorMarkerFixEditor extends CustomEditor {
    render(width: number): string[] {
        // Get the base render output
        const lines = super.render(width);

        // If not focused, no need to inject cursor marker
        if (!this.focused) {
            return lines;
        }

        // Find lines with highlighted cursor and inject CURSOR_MARKER before it
        const result: string[] = [];
        for (const line of lines) {
            // Check if this line has a rendered cursor (inverse video block)
            if (line.includes("\x1b[7m") && !line.includes(CURSOR_MARKER)) {
                // Insert CURSOR_MARKER before the inverse video start
                // This positions the hardware cursor at the same spot as the fake cursor
                result.push(line.replace("\x1b[7m", `${CURSOR_MARKER}\x1b[7m`));
            } else {
                result.push(line);
            }
        }

        return result;
    }
}

// Extension factory function
export default function (pi: ExtensionAPI) {
    pi.on("session_start", (event, ctx) => {
        ctx.ui.setEditorComponent(
            (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
                return new CursorMarkerFixEditor(tui, theme, keybindings);
            },
        );
    });
}
