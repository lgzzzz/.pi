/**
 * 子代理调用
 *
 * 通过 spawn 启动独立的 pi 进程来执行子代理。
 * 负责构建命令行参数、管理临时文件、收集输出流、
 * 处理中止信号以及清理资源。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import type { OnUpdateCallback, SubagentDetails } from "./types.js";
import type { SingleResult } from "../utils/messages.js";
import { getFinalOutput } from "../utils/messages.js";
import { getPiInvocation, writePromptToTempFile } from "../utils/process.js";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 构造未知代理的错误结果 */
function unknownAgentResult(
    agentName: string,
    agents: AgentConfig[],
    task: string,
    step: number | undefined,
): SingleResult {
    const available =
        agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
        agent: agentName,
        agentSource: "unknown",
        task,
        exitCode: 1,
        messages: [],
        stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, contextTokens: 0 },
        step,
    };
}

/** 构造空的用量统计 */
function emptyUsage(): SingleResult["usage"] {
    return { input: 0, output: 0, cacheRead: 0, cost: 0, contextTokens: 0 };
}

// ---------------------------------------------------------------------------
// JSON 输出流解析
// ---------------------------------------------------------------------------

/**
 * 解析 pi 进程输出的单行 JSON 事件，并更新执行结果。
 *
 * 处理两种事件类型：
 * - message_end: 助手消息完成，累加用量统计
 * - tool_result_end: 工具结果消息，追加到消息列表
 */
function handleJsonLine(
    line: string,
    result: SingleResult,
    emitUpdate: () => void,
): void {
    if (!line.trim()) return;

    let event: any;
    try {
        event = JSON.parse(line);
    } catch {
        return;
    }

    // 助手消息完成 — 累加用量统计
    if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        result.messages.push(msg);

        if (msg.role === "assistant") {
            const usage = msg.usage;
            if (usage) {
                result.usage.input += usage.input || 0;
                result.usage.output += usage.output || 0;
                result.usage.cacheRead += usage.cacheRead || 0;
                result.usage.cost =
                    (result.usage.cost ?? 0) + (usage.cost?.total || 0);
                result.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!result.model && msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
        }
        emitUpdate();
    }

    // 工具结果消息 — 追加到消息列表
    if (event.type === "tool_result_end" && event.message) {
        result.messages.push(event.message as Message);
        emitUpdate();
    }
}

// ---------------------------------------------------------------------------
// 核心调用函数
// ---------------------------------------------------------------------------

/**
 * 执行单个子代理。
 *
 * 启动 pi 子进程，收集 JSON 输出流中的消息和用量统计，
 * 并通过 onUpdate 回调实时报告中间进度。
 */
export async function runSingleAgent(
    defaultCwd: string,
    agents: AgentConfig[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
    // ── 1. 查找代理配置 ──────────────────────────────────────
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
        return unknownAgentResult(agentName, agents, task, step);
    }

    // ── 2. 初始化结果对象 ──────────────────────────────────────
    const currentResult: SingleResult = {
        agent: agentName,
        agentSource: agent.source,
        task,
        exitCode: 0,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        model: agent.model,
        step,
    };

    const emitUpdate = () => {
        if (!onUpdate) return;
        onUpdate({
            content: [
                {
                    type: "text",
                    text:
                        getFinalOutput(currentResult.messages) || "(running...)",
                },
            ],
            details: makeDetails([currentResult]),
        });
    };

    // ── 3. 写入系统提示临时文件 ──────────────────────────────────
    let tmpDir: string | null = null;
    let tmpPath: string | null = null;

    try {
        if (agent.systemPrompt.trim()) {
            const tmp = await writePromptToTempFile(
                agent.name,
                agent.systemPrompt,
            );
            tmpDir = tmp.dir;
            tmpPath = tmp.filePath;
        }

        // ── 4. 构建 CLI 参数 ──────────────────────────────────────
        const args: string[] = ["--mode", "json", "-p"];
        if (agent.model) args.push("--model", agent.model);
        if (agent.tools && agent.tools.length > 0)
            args.push("--tools", agent.tools.join(","));
        if (tmpPath) args.push("--append-system-prompt", tmpPath);
        args.push(`Task: ${task}`);

        // ── 5. 启动子进程 ──────────────────────────────────────────
        let wasAborted = false;

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd: cwd ?? defaultCwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let buffer = "";

            // 处理 stdout：按行解析 JSON 事件
            proc.stdout.on("data", (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines)
                    handleJsonLine(line, currentResult, emitUpdate);
            });

            // 收集 stderr
            proc.stderr.on("data", (data: Buffer) => {
                currentResult.stderr += data.toString();
            });

            // 进程退出
            proc.on("close", (code) => {
                if (buffer.trim())
                    handleJsonLine(buffer, currentResult, emitUpdate);
                resolve(code ?? 0);
            });

            // 进程错误
            proc.on("error", () => resolve(1));

            // ── 6. 中止信号处理 ──────────────────────────────────────
            if (signal) {
                const killProc = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted) killProc();
                else signal.addEventListener("abort", killProc, { once: true });
            }
        });

        currentResult.exitCode = exitCode;
        if (wasAborted) throw new Error("Subagent was aborted");
        return currentResult;
    } finally {
        // ── 7. 清理临时文件 ──────────────────────────────────────────
        if (tmpPath) {
            try { fs.unlinkSync(tmpPath); } catch { /* 忽略清理失败 */ }
        }
        if (tmpDir) {
            try { fs.rmdirSync(tmpDir); } catch { /* 忽略清理失败 */ }
        }
    }
}