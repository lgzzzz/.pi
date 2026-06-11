import type { AgentPreset } from "./types.js";

/**
 * Preset sub-agent configurations.
 *
 * Each preset defines the label, description, allowed tools (tool whitelist),
 * optional model override, and default timeout for a sub-agent.
 */
export const AGENT_PRESETS: Record<string, AgentPreset> = {
    "spec-reviewer": {
        label: "Spec Reviewer",
        description:
            "审查 SPEC.md 规范文档的完整性和清晰度。" +
            "检查需求是否明确、范围是否合理、边界情况是否覆盖。",
        tools: [],
        timeout: 300_000, // 5 minutes
    },
    "plan-reviewer": {
        label: "Plan Reviewer",
        description:
            "审查 PLAN.md 执行计划的可行性和完整性。" +
            "检查任务拆分是否合理、依赖关系是否正确、验收标准是否可验证。",
        tools: [],
        timeout: 300_000, // 5 minutes
    },
    "plan-executor": {
        label: "Plan Executor",
        description:
            "按照 PLAN.md 逐任务执行代码修改。" +
            "具备 read / edit / write / bash / grep / find / ls 工具，可读取文件、修改代码、运行命令。",
        tools: ["read", "edit", "write", "bash", "grep", "find", "ls"],
        timeout: 600_000, // 10 minutes
    },
};
