/**
 * 代理发现与配置
 *
 * 从用户目录和项目目录扫描代理定义文件（.md），
 * 解析 frontmatter 元数据，构建代理配置列表。
 * 支持代理搜索范围设为 user / project / both。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 代理搜索范围 */
export type AgentScope = "user" | "project" | "both";

/** 代理配置 — 从 .md 文件中解析而得 */
export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

/** 代理发现结果 */
export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectAgentsDir: string | null;
}

// ---------------------------------------------------------------------------
// 代理扫描
// ---------------------------------------------------------------------------

/** 从指定目录加载所有 .md 代理配置文件 */
function loadAgentsFromDir(
    dir: string,
    source: "user" | "project",
): AgentConfig[] {
    const agents: AgentConfig[] = [];

    if (!fs.existsSync(dir)) return agents;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return agents;
    }

    for (const entry of entries) {
        // 仅处理 .md 文件（含符号链接）
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        } catch {
            continue;
        }

        const { frontmatter, body } =
            parseFrontmatter<Record<string, string>>(content);

        // 跳过缺少必要字段的文件
        if (!frontmatter.name || !frontmatter.description) continue;

        const tools = frontmatter.tools
            ?.split(",")
            .map((t: string) => t.trim())
            .filter(Boolean);

        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools && tools.length > 0 ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            source,
            filePath,
        });
    }

    return agents;
}

// ---------------------------------------------------------------------------
// 项目目录查找
// ---------------------------------------------------------------------------

/** 判断路径是否为有效目录 */
function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** 从当前工作目录向上查找最近的项目 .pi/agents 目录 */
function findNearestProjectAgentsDir(cwd: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, ".pi", "agents");
        if (isDirectory(candidate)) return candidate;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null; // 已到达根目录
        currentDir = parentDir;
    }
}

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/**
 * 发现可用代理。
 *
 * 根据搜索范围从用户目录和/或项目目录加载代理配置。
 * 同名代理时，后加载的会覆盖先加载的（project 优先于 user）。
 */
export function discoverAgents(
    cwd: string,
    scope: AgentScope,
): AgentDiscoveryResult {
    const userDir = path.join(getAgentDir(), "agents");
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);

    const userAgents =
        scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
    const projectAgents =
        scope === "user" || !projectAgentsDir
            ? []
            : loadAgentsFromDir(projectAgentsDir, "project");

    // 使用 Map 去重：同名代理后者覆盖前者
    const agentMap = new Map<string, AgentConfig>();

    if (scope === "both") {
        for (const agent of userAgents) agentMap.set(agent.name, agent);
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    } else if (scope === "user") {
        for (const agent of userAgents) agentMap.set(agent.name, agent);
    } else {
        for (const agent of projectAgents) agentMap.set(agent.name, agent);
    }

    return { agents: Array.from(agentMap.values()), projectAgentsDir };
}