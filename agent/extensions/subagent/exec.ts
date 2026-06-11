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
// Exec Adapter (shared pattern with junie.ts)
// ---------------------------------------------------------------------------

/**
 * Create an exec adapter that wraps a pi ExtensionAPI.exec call.
 */
export function createPiExecAdapter(
    piExec: (
        command: string,
        args: string[],
        options?: {
            signal?: AbortSignal;
            timeout?: number;
            cwd?: string;
        },
    ) => Promise<{
        code?: number;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
    }>,
): (
    command: string,
    args: string[],
    options?: SubagentExecOptions,
) => Promise<SubagentExecResult> {
    return async (command, args, options) => {
        const result = await piExec(command, args, {
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
// Command Builder
// ---------------------------------------------------------------------------

/**
 * Build the pi CLI argument list for a sub-agent invocation.
 *
 * Command format:
 *   pi [--model <model>] (--no-tools | --tools <list>) --thinking off -p "<task>"
 */
export function buildPiArgs(
    preset: AgentPreset,
    task: string,
): string[] {
    const args: string[] = [];

    // Model override (optional)
    if (preset.model) {
        args.push("--model", preset.model);
    }

    // Tool configuration
    if (preset.tools.length === 0) {
        args.push("--no-tools");
    } else {
        args.push("--tools", preset.tools.join(","));
    }

    // Disable thinking for cost efficiency in sub-agents
    args.push("--thinking", "off");

    // Print (non-interactive) mode
    args.push("-p", task);

    return args;
}

// ---------------------------------------------------------------------------
// Result Parser
// ---------------------------------------------------------------------------

/**
 * Parse raw sub-agent output into structured SubagentToolDetails.
 */
export function parseResult(
    agent: string,
    task: string,
    result: SubagentExecResult,
): SubagentToolDetails {
    const fullOutput = result.stdout || "";

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
