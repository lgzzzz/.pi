/**
 * 子代理执行模式
 *
 * 实现三种执行模式的核心逻辑：
 * - single:  单次代理调用
 * - parallel: 多个代理并行执行（限并发数）
 * - chain:   多个代理链式串行执行，前一步输出可传递给后一步
 */

import type { AgentConfig } from "./agents.js";
import type { OnUpdateCallback, SubagentDetails } from "./types.js";
import type { SingleResult } from "../utils/messages.js";
import {
    getFinalOutput,
    isFailedResult,
    getResultOutput,
} from "../utils/messages.js";
import { mapWithConcurrencyLimit } from "../utils/async.js";
import { MAX_PARALLEL_TASKS, MAX_CONCURRENCY } from "../utils/constants.js";
import { runSingleAgent } from "./invoke.js";

// ---------------------------------------------------------------------------
// 链式执行
// ---------------------------------------------------------------------------

/**
 * 链式执行 — 依次运行多个代理步骤，每步可引用前一步的输出。
 * 若某步失败则立即中断链并返回错误结果。
 */
export async function executeChain(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const results: SingleResult[] = [];
    let previousOutput = "";

    for (let i = 0; i < params.chain.length; i++) {
        const step = params.chain[i];
        const taskWithContext = step.task.replace(
            /\{previous\}/g,
            previousOutput,
        );

        // 为链中每步构造进度回调，包含之前所有步骤的结果
        const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                  const currentResult = partial.details?.results[0];
                  if (currentResult) {
                      const allResults = [...results, currentResult];
                      onUpdate({
                          content: partial.content,
                          details: makeDetails(allResults),
                      });
                  }
              }
            : undefined;

        const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1, // 步骤编号（1-indexed）
            signal,
            chainUpdate,
            makeDetails,
        );
        results.push(result);

        // 某步失败则立即中断链
        if (isFailedResult(result)) {
            const errorMsg = getResultOutput(result);
            return {
                content: [
                    {
                        type: "text",
                        text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                    },
                ],
                details: makeDetails(results),
                isError: true,
            };
        }

        previousOutput = getFinalOutput(result.messages);
    }

    // 链完成 — 返回最后一步的输出
    return {
        content: [
            {
                type: "text",
                text:
                    getFinalOutput(results[results.length - 1].messages) ||
                    "(no output)",
            },
        ],
        details: makeDetails(results),
    };
}

// ---------------------------------------------------------------------------
// 并行执行
// ---------------------------------------------------------------------------

/**
 * 并行执行 — 同时运行多个代理，限制最大并发数。
 * 任务数不得超过 MAX_PARALLEL_TASKS。
 */
export async function executeParallel(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const tasks = params.tasks as {
        agent: string;
        task: string;
        cwd?: string;
    }[];

    if (tasks.length > MAX_PARALLEL_TASKS) {
        return {
            content: [
                {
                    type: "text",
                    text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
            ],
            details: makeDetails([]),
        };
    }

    // 预分配结果槽位（用于实时进度更新，exitCode=-1 表示尚未完成）
    const allResults: SingleResult[] = tasks.map((t) => ({
        agent: t.agent,
        agentSource: "unknown" as const,
        task: t.task,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cost: 0, contextTokens: 0 },
    }));

    // 广播并行进度
    const emitParallelUpdate = () => {
        if (!onUpdate) return;
        const running = allResults.filter((r) => r.exitCode === -1).length;
        const done = allResults.filter((r) => r.exitCode !== -1).length;
        onUpdate({
            content: [
                {
                    type: "text",
                    text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
            ],
            details: makeDetails([...allResults]),
        });
    };

    // 并发执行（控制最大并发数）
    const results = await mapWithConcurrencyLimit(
        tasks,
        MAX_CONCURRENCY,
        async (t, index) => {
            const result = await runSingleAgent(
                ctx.cwd,
                agents,
                t.agent,
                t.task,
                t.cwd,
                undefined,
                signal,
                (partial) => {
                    if (partial.details?.results[0]) {
                        allResults[index] = partial.details.results[0];
                        emitParallelUpdate();
                    }
                },
                makeDetails,
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
        },
    );

    // 汇总结果
    const successCount = results.filter((r) => !isFailedResult(r)).length;
    const summaries = results.map((r) => {
        const output = getFinalOutput(r.messages);
        const preview =
            output.slice(0, 100) + (output.length > 100 ? "..." : "");
        const status = isFailedResult(r) ? "failed" : "completed";
        return `[${r.agent}] ${status}: ${preview || "(no output)"}`;
    });

    return {
        content: [
            {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            },
        ],
        details: makeDetails(results),
    };
}

// ---------------------------------------------------------------------------
// 单次执行
// ---------------------------------------------------------------------------

/** 单次执行 — 调用单个代理并返回结果 */
export async function executeSingle(
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdateCallback | undefined,
    ctx: any,
    agents: AgentConfig[],
    makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<any> {
    const result = await runSingleAgent(
        ctx.cwd,
        agents,
        params.agent,
        params.task,
        params.cwd,
        undefined,
        signal,
        onUpdate,
        makeDetails,
    );

    if (isFailedResult(result)) {
        const errorMsg = getResultOutput(result);
        return {
            content: [
                {
                    type: "text",
                    text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
                },
            ],
            details: makeDetails([result]),
            isError: true,
        };
    }

    return {
        content: [
            {
                type: "text",
                text: getFinalOutput(result.messages) || "(no output)",
            },
        ],
        details: makeDetails([result]),
    };
}