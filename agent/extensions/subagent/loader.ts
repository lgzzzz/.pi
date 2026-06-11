import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentPreset } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory where sub-agent markdown definitions live (relative to extension) */
const SUBAGENTS_DIR = "../../subagents";

/** Regex to parse YAML frontmatter (delimited by ---) */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// ---------------------------------------------------------------------------
// Frontmatter Parser
// ---------------------------------------------------------------------------

/**
 * Parse simple YAML frontmatter lines into a Record.
 * Supports only the subset we need: strings, numbers, and arrays of strings.
 */
function parseFrontmatter(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const line of yaml.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) continue;

        const key = trimmed.slice(0, colonIdx).trim();
        let value: unknown = trimmed.slice(colonIdx + 1).trim();

        // Array: [a, b, c]
        if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
            const inner = value.slice(1, -1).trim();
            if (inner === "") {
                value = [];
            } else {
                value = inner.split(",").map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""));
            }
        } else if (typeof value === "string") {
            // Unquote string values
            value = value.replace(/^['"]|['"]$/g, "");
            // Try to parse as number
            const num = Number(value);
            if (!isNaN(num) && String(num) === value) {
                value = num;
            }
        }

        result[key] = value;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Markdown Loader
// ---------------------------------------------------------------------------

/** Raw data parsed from a sub-agent markdown file */
interface SubagentMarkdown {
    name: string;
    description: string;
    tools: string[];
    timeout: number;
    model?: string;
    systemPrompt: string;
}

/**
 * Parse a sub-agent markdown file.
 *
 * Format:
 *   ---
 *   name: agent-name
 *   description: Agent description
 *   tools: [tool1, tool2]  # only explicitly listed tools; empty or absent = no tools
 *   timeout: 300000         # optional, defaults to 300000
 *   model: provider/id      # optional
 *   ---
 *   # System Prompt
 *   ...instructions...
 */
function parseMarkdown(content: string): SubagentMarkdown | null {
    const match = content.match(FRONTMATTER_RE);
    if (!match) return null;

    const [, yaml, body] = match;
    const meta = parseFrontmatter(yaml ?? "");

    const name = String(meta.name ?? "");
    if (!name) return null;

    return {
        name,
        description: String(meta.description ?? ""),
        tools: Array.isArray(meta.tools) ? meta.tools.map(String) : [],
        timeout: typeof meta.timeout === "number" ? meta.timeout : 300_000,
        model: meta.model ? String(meta.model) : undefined,
        systemPrompt: (body ?? "").trim(),
    };
}

/**
 * Load all sub-agent presets from the markdown definitions directory.
 */
export function loadPresets(): Record<string, AgentPreset> {
    const extDir = dirname(fileURLToPath(import.meta.url));
    const dir = resolve(extDir, SUBAGENTS_DIR);

    const presets: Record<string, AgentPreset> = {};

    let files: string[];
    try {
        files = readdirSync(dir);
    } catch {
        return presets;
    }

    for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const content = readFileSync(resolve(dir, file), "utf-8");
        const parsed = parseMarkdown(content);
        if (!parsed) continue;

        presets[parsed.name] = {
            label: parsed.name,
            description: parsed.description,
            tools: parsed.tools,
            model: parsed.model,
            timeout: parsed.timeout,
            systemPrompt: parsed.systemPrompt,
        };
    }

    return presets;
}
