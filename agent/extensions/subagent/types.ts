/**
 * Types for the Subagent Extension
 */

/** Configuration for a sub-agent preset */
export interface AgentPreset {
    /** Display label for the sub-agent */
    label: string;
    /** Description shown in TUI and LLM context */
    description: string;
    /** Allowed tools (empty array = no tools, pure reasoning) */
    tools: string[];
    /** Optional model override (defaults to main agent's model if undefined) */
    model?: string;
    /** Default timeout in milliseconds */
    timeout: number;
}

/** Details returned by the delegate tool execution */
export interface SubagentToolDetails {
    agent: string;
    task: string;
    summary: string;
    fullOutput: string;
    exitCode: number | null;
    error?: string;
    status?: string;
}

/** Options for shell command execution */
export interface SubagentExecOptions {
    signal?: AbortSignal;
    timeout?: number;
    cwd?: string;
}

/** Result from a shell command execution */
export interface SubagentExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
}

/** Options for createSubagentToolDefinition */
export interface SubagentToolOptions {
    /**
     * Function to execute shell commands.
     * When used inside a pi extension, pass a wrapper around pi.exec().
     */
    exec?: (
        command: string,
        args: string[],
        options?: SubagentExecOptions,
    ) => Promise<SubagentExecResult>;
}
