/**
 * 子代理核心类型定义
 *
 * 定义子代理工具的 TypeScript 类型接口，
 * 与运行时参数模式（schemas.ts）和代理发现（agents.ts）配合使用。
 */

import type { AgentScope } from "./agents.js";
import type { SingleResult } from "../utils/messages.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** 子代理结果更新回调 — 当子代理产生中间进度时通知调用方 */
export type OnUpdateCallback = (
    partial: AgentToolResult<SubagentDetails>,
) => void;

/** 子代理执行结果的详细信息 — 附加在 AgentToolResult.details 中供渲染函数使用 */
export interface SubagentDetails {
    /** 执行模式：single / parallel / chain */
    mode: "single" | "parallel" | "chain";
    /** 代理搜索范围 */
    agentScope: AgentScope;
    /** 项目代理目录路径（用于 UI 确认提示） */
    projectAgentsDir: string | null;
    /** 各步骤/任务的执行结果 */
    results: SingleResult[];
}