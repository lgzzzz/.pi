/**
 * 历史扩展 — 配置加载
 *
 * 从以下位置读取历史查看器配置（项目配置优先）：
 *   - ~/.pi/agent/extensions/history.json（全局）
 *   - <cwd>/.pi/history.json（项目本地）
 *
 * 配置示例：
 * ```json
 * {
 *   "autoOpenOnStart": true
 * }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface HistoryConfig {
    /** 是否在 agent_start 时自动打开历史查看器。 */
    autoOpenOnStart: boolean;
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: HistoryConfig = {
    autoOpenOnStart: true,
};

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------

/**
 * 加载历史查看器的合并配置。
 *
 * 合并顺序（后者覆盖前者）：
 *   默认值 → 全局配置 → 项目配置
 */
export function loadConfig(cwd: string): HistoryConfig {
    const globalConfigPath = join(getAgentDir(), "extensions", "history.json");
    const projectConfigPath = join(cwd, ".pi", "history.json");

    let globalConfig: Partial<HistoryConfig> = {};
    let projectConfig: Partial<HistoryConfig> = {};

    if (existsSync(globalConfigPath)) {
        try {
            globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
        } catch (e) {
            console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
        }
    }

    if (existsSync(projectConfigPath)) {
        try {
            projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
        } catch (e) {
            console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
        }
    }

    return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
