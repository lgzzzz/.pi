import { spawn } from "node:child_process";

import type {
    AgentPreset,
    SubagentExecOptions,
    SubagentExecResult,
    SubagentToolDetails,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of lines to show in collapsed result preview */
export const PREVIEW_LINES = 8;

/** Maximum characters for the summary field */
export const MAX_SUMMARY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Command Builder
// ---------------------------------------------------------------------------

/**
 * Build the pi CLI argument list for RPC-mode sub-agent invocation.
 *
 * Command format:
 *   pi --mode rpc [--model <model>] --system-prompt <prompt> (--no-tools | --tools <list>)
 *
 * The task is sent via stdin as a JSON-RPC prompt command, not as a CLI argument.
 */
export function buildRpcArgs(preset: AgentPreset): string[] {
    const args: string[] = ["--mode", "rpc"];

    // Model override (optional)
    if (preset.model) {
        args.push("--model", preset.model);
    }

    // System prompt from markdown body
    if (preset.systemPrompt) {
        args.push("--system-prompt", preset.systemPrompt);
    }

    // Tool configuration (only explicitly listed tools, no defaults)
    if (preset.tools.length === 0) {
        args.push("--no-tools");
    } else {
        args.push("--tools", preset.tools.join(","));
    }

    return args;
}

// ---------------------------------------------------------------------------
// Subagent Execution (RPC mode via child_process.spawn)
// ---------------------------------------------------------------------------

/**
 * Execute a sub-agent via pi RPC mode.
 *
 * Spawns `pi --mode rpc ...`, sends a JSON-RPC prompt command to stdin,
 * then closes stdin and collects the JSONL event stream from stdout.
 */
export function executeSubagent(
    args: string[],
    task: string,
    options?: SubagentExecOptions,
): Promise<SubagentExecResult> {
    return new Promise((resolve, reject) => {
        const child = spawn("pi", args, {
            cwd: options?.cwd,
            signal: options?.signal,
            timeout: options?.timeout,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data: Buffer) => {
            stdout += data.toString();
        });

        child.stderr?.on("data", (data: Buffer) => {
            stderr += data.toString();
        });

        child.on("error", (err: Error) => {
            reject(err);
        });

        child.on("close", (code: number | null) => {
            resolve({
                code,
                stdout,
                stderr,
                killed: child.killed,
            });
        });

        // Send the RPC prompt command, then close stdin to signal EOF
        const rpcCommand = JSON.stringify({
            type: "prompt",
            message: task,
        }) + "\n";

        child.stdin?.write(rpcCommand);
        child.stdin?.end();
    });
}

// ---------------------------------------------------------------------------
// RPC Output Parser
// ---------------------------------------------------------------------------

/**
 * Parse the JSONL stdout from pi RPC mode into plain text.
 *
 * Extracts the final assistant message content from the event stream.
 * Returns the concatenated text of all assistant messages.
 */
function parseRpcOutput(stdout: string): string {
    const lines = stdout.split("\n");
    const events: unknown[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            events.push(JSON.parse(trimmed));
        } catch {
            // Skip non-JSON lines (e.g. startup warnings)
        }
    }

    // Find the last agent_end event which contains all messages
    let agentEndEvent: { messages?: Array<{ role: string; content?: Array<{ type: string; text?: string }> }> } | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i] as Record<string, unknown>;
        if (event.type === "agent_end") {
            agentEndEvent = event as typeof agentEndEvent;
            break;
        }
    }

    if (!agentEndEvent?.messages) {
        return "";
    }

    // Collect text from assistant messages
    const parts: string[] = [];
    for (const msg of agentEndEvent.messages) {
        if (msg.role !== "assistant") continue;
        if (!msg.content) continue;
        for (const block of msg.content) {
            if (block.type === "text" && block.text) {
                parts.push(block.text);
            }
        }
    }

    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Result Parser
// ---------------------------------------------------------------------------

/**
 * Parse sub-agent execution result into structured SubagentToolDetails.
 *
 * Parses RPC JSONL output to extract the final assistant text,
 * then builds the structured result with summary and error handling.
 */
export function parseResult(
    agent: string,
    task: string,
    result: SubagentExecResult,
): SubagentToolDetails {
    // Parse RPC output to get plain text
    const fullOutput = parseRpcOutput(result.stdout);

    // Build summary: first N chars of output
    let summary: string;
    if (!fullOutput.trim()) {
        summary = "(No output)";
    } else if (fullOutput.length <= MAX_SUMMARY_LENGTH) {
        summary = fullOutput.trim();
    } else {
        summary = fullOutput.slice(0, MAX_SUMMARY_LENGTH).trimEnd() + "...";
    }

    // Handle killed (timeout)
    if (result.killed) {
        return {
            agent,
            task,
            summary,
            fullOutput,
            exitCode: null,
            error: "timeout",
        };
    }

    // Handle non-zero exit code (error)
    if (result.code !== 0) {
        return {
            agent,
            task,
            summary,
            fullOutput,
            exitCode: result.code,
            error: result.stderr || `Exit code: ${result.code}`,
        };
    }

    // Success
    return {
        agent,
        task,
        summary,
        fullOutput,
        exitCode: result.code,
    };
}
