/**
 * buildFooterLines — 可复用的纯函数，按 pi 原生 footer 格式生成两行字符串。
 *
 * 不依赖 pi 内部状态，接受所有渲染所需数据作为参数。
 * 其他扩展可以 import 此函数在自己的 UI 中渲染相同的 footer。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// 定价与费用计算
// ---------------------------------------------------------------------------

/** 模型定价接口（每百万 tokens 价格，元） */
interface ModelPricing {
    inputUncached: number;
    inputCached: number;
    output: number;
}

/** 定价表 — 按模型 ID 查找（仅 DeepSeek V4 系列硬编码） */
const PRICING_MAP: Record<string, ModelPricing> = {
    "deepseek-v4-pro": {
        inputUncached: 2,    // 未命中缓存：2 元/百万 tokens
        inputCached: 0.025,  // 命中缓存：0.025 元/百万 tokens
        output: 6,           // 输出：6 元/百万 tokens
    },
    "deepseek-v4-flash": {
        inputUncached: 1,    // 未命中缓存：1 元/百万 tokens
        inputCached: 0.02,   // 命中缓存：0.02 元/百万 tokens
        output: 2,           // 输出：2 元/百万 tokens
    },
};

/** 默认回退定价（deepseek-v4-pro） */
const DEFAULT_PRICING: ModelPricing = { inputUncached: 2, inputCached: 0.025, output: 6 };

/**
 * 解析定价：
 * 1. DeepSeek V4 系列 → 用硬编码 PRICING_MAP
 * 2. 其他模型且有 costConfig → 从模型配置读取
 * 3. 否则 → 回退到 DEFAULT_PRICING
 */
function resolvePricing(
    modelName: string,
    modelCost?: { input: number; output: number; cacheRead: number; cacheWrite: number },
): ModelPricing {
    const hardcoded = PRICING_MAP[modelName];
    if (hardcoded) return hardcoded;

    if (modelCost && (modelCost.input > 0 || modelCost.output > 0)) {
        return {
            inputUncached: modelCost.input,
            inputCached: modelCost.cacheRead,
            output: modelCost.output,
        };
    }

    return DEFAULT_PRICING;
}

/** 根据 token 数和定价计算费用 */
function calcCost(tokens: number, pricePerMillion: number): number {
    return (tokens / 1_000_000) * pricePerMillion;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 格式化 token 数量：<1000 原样，<10000 x.xk，<1M xk，<10M x.xM，>=10M xM */
function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

/** cwd 转 ~/... 形式（与原生一致） */
function formatCwd(cwd: string, home: string | undefined): string {
    if (!home) return cwd;
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const rel = relative(resolvedHome, resolvedCwd);
    const insideHome =
        rel === "" ||
        (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!insideHome) return cwd;
    return rel === "" ? "~" : `~${sep}${rel}`;
}

// ---------------------------------------------------------------------------
// 核心函数
// ---------------------------------------------------------------------------

export interface FooterLinesOptions {
    /** 终端宽度（字符数） */
    width: number;
    /** 当前工作目录 */
    cwd: string;
    /** HOME 目录路径 */
    home: string | undefined;

    // ── 路径装饰 ──
    /** git 分支名（可选） */
    gitBranch?: string;
    /** session 名称（可选） */
    sessionName?: string;

    // ── Token 统计 ──
    /** 未命中缓存输入 tokens */
    totalInput: number;
    /** 输出 tokens */
    totalOutput: number;
    /** 命中缓存 tokens */
    totalCacheRead: number;
    /** 写入缓存 tokens */
    totalCacheWrite: number;

    // ── 费用 ──
    /** 是否使用 OAuth 订阅 */
    usingSubscription: boolean;

    // ── 上下文 ──
    /** 上下文已使用 token 数，null 则显示 ? */
    contextTokens: number | null | undefined;
    /** 上下文窗口大小 */
    contextWindow: number;

    // ── 模型 ──
    /** 模型 ID，如 "deepseek-v4-pro" */
    modelName: string;
    /** 模型自身的 cost 定价（从 ctx.model.cost 读取，每百万 tokens），非 DeepSeek V4 系列使用 */
    modelCost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /** provider 名称，如 "opencode-go" */
    provider?: string;
    /** 模型是否支持 reasoning */
    modelReasoning: boolean;
    /** thinking level */
    thinkingLevel: string;

    // ── 主题着色 ──
    /** 前景色着色函数，如 theme.fg */
    fg: (color: ThemeColor, text: string) => string;
}

export function buildFooterLines(opts: FooterLinesOptions): string[] {
    const { fg } = opts;

    // ── 第 1 行：路径 + git branch + session name ─────────────────────
    let pwd = formatCwd(opts.cwd, opts.home);
    if (opts.gitBranch) pwd = `${pwd} (${opts.gitBranch})`;
    if (opts.sessionName) pwd = `${pwd} • ${opts.sessionName}`;

    // ── 第 2 行：stats ────────────────────────────────────────────────
    const statsParts: string[] = [];

    if (opts.totalInput) statsParts.push(`↑${formatTokens(opts.totalInput)}`);
    if (opts.totalOutput)
        statsParts.push(`↓${formatTokens(opts.totalOutput)}`);
    if (opts.totalCacheRead)
        statsParts.push(`R${formatTokens(opts.totalCacheRead)}`);
    if (opts.totalCacheWrite)
        statsParts.push(`W${formatTokens(opts.totalCacheWrite)}`);

    // 缓存命中率 — 整个 session 的 cacheRead / (input + cacheRead)
    const totalPromptTokens = opts.totalInput + opts.totalCacheRead;
    if (totalPromptTokens > 0) {
        const cacheHitRate = (opts.totalCacheRead / totalPromptTokens) * 100;
        statsParts.push(`${cacheHitRate.toFixed(1)}%`);
    }

    // 费用（由 buildFooterLines 内部根据 token 数计算，按模型选择定价）
    const isDeepSeekV4 = opts.modelName === "deepseek-v4-pro" || opts.modelName === "deepseek-v4-flash";
    const pricing = resolvePricing(opts.modelName, opts.modelCost);
    const cost =
        calcCost(opts.totalInput, pricing.inputUncached) +
        calcCost(opts.totalCacheRead, pricing.inputCached) +
        calcCost(opts.totalOutput, pricing.output);
    if (cost || opts.usingSubscription) {
        const currency = isDeepSeekV4 ? "¥" : "$";
        const sub = opts.usingSubscription ? " (sub)" : "";
        statsParts.push(`${currency}${cost.toFixed(3)}${sub}`);
    }

    // 上下文使用量（实际 token 数）
    let contextDisplay: string;
    if (opts.contextTokens === null || opts.contextTokens === undefined) {
        contextDisplay = `?/${formatTokens(opts.contextWindow)}`;
    } else {
        contextDisplay = `${formatTokens(opts.contextTokens)}/${formatTokens(opts.contextWindow)}`;
    }

    // 颜色：按百分比判断
    const contextPct =
        opts.contextWindow > 0
            ? ((opts.contextTokens ?? 0) / opts.contextWindow) * 100
            : 0;
    let contextStr: string;
    if (contextPct > 90) {
        contextStr = fg("error", contextDisplay);
    } else if (contextPct > 70) {
        contextStr = fg("warning", contextDisplay);
    } else {
        contextStr = contextDisplay;
    }
    statsParts.push(contextStr);

    // 统计左侧（可能包含颜色代码）
    let statsLeft = statsParts.join(" ");
    let statsLeftWidth = visibleWidth(statsLeft);

    // 如果 statsLeft 太宽，先截断
    if (statsLeftWidth > opts.width) {
        statsLeft = truncateToWidth(statsLeft, opts.width, "...");
        statsLeftWidth = visibleWidth(statsLeft);
    }

    // ── 右侧：模型名（含 provider、thinking level） ──────────────────
    const modelName = opts.modelName || "no-model";
    let rightSideWithoutProvider = modelName;
    if (opts.modelReasoning) {
        const level = opts.thinkingLevel || "off";
        rightSideWithoutProvider =
            level === "off"
                ? `${modelName} • thinking off`
                : `${modelName} • ${level}`;
    }
    // 多 provider 时前置 (provider)
    let rightSide = rightSideWithoutProvider;
    if (opts.provider) {
        const withProvider = `(${opts.provider}) ${rightSideWithoutProvider}`;
        if (statsLeftWidth + 2 + visibleWidth(withProvider) <= opts.width) {
            rightSide = withProvider;
        }
    }

    // ── 布局：左侧 stats + padding + 右侧模型名 ─────────────────────
    const rightWidth = visibleWidth(rightSide);
    const minPadding = 2;

    let statsLine: string;
    if (statsLeftWidth + minPadding + rightWidth <= opts.width) {
        const padding = " ".repeat(
            opts.width - statsLeftWidth - rightWidth,
        );
        statsLine = statsLeft + padding + rightSide;
    } else {
        const available = opts.width - statsLeftWidth - minPadding;
        if (available > 0) {
            const truncatedRight = truncateToWidth(rightSide, available, "");
            const pad = " ".repeat(
                Math.max(
                    0,
                    opts.width -
                        statsLeftWidth -
                        visibleWidth(truncatedRight),
                ),
            );
            statsLine = statsLeft + pad + truncatedRight;
        } else {
            statsLine = statsLeft;
        }
    }

    // ── 输出 ─────────────────────────────────────────────────────────
    const pwdLine = truncateToWidth(
        fg("dim", pwd),
        opts.width,
        fg("dim", "..."),
    );
    return [pwdLine, fg("dim", statsLine)];
}
