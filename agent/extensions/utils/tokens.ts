/**
 * Token 格式化、定价与用量统计工具
 *
 * 提取自 deepseek-utils.ts，为 subagent、deepseek-footer 提供：
 * - Token 数量紧凑格式化
 * - DeepSeek 模型定价（¥ 人民币 / 1M token）
 * - 费用计算
 * - 用量统计格式化（页脚风格）
 * - 用量聚合
 */

// ---------------------------------------------------------------------------
// DeepSeek 模型定价（¥ 人民币，每 1M token）
// ---------------------------------------------------------------------------

export interface DeepSeekPricing {
  /** ¥ / 1M token — 缓存命中输入 */
  cacheHit: number;
  /** ¥ / 1M token — 缓存未命中输入 */
  cacheMiss: number;
  /** ¥ / 1M token — 输出 */
  output: number;
}

export const DEEPSEEK_PRICING: Record<string, DeepSeekPricing> = {
  "deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 2 },
  "deepseek-v4-pro":  { cacheHit: 0.025, cacheMiss: 3, output: 6 },
};

/** 未知 DeepSeek 模型的回退定价（保守估算） */
export const FALLBACK_DEEPSEEK_PRICING: DeepSeekPricing = {
  cacheHit: 0.1, cacheMiss: 2, output: 4,
};

// ---------------------------------------------------------------------------
// 费用计算
// ---------------------------------------------------------------------------

/**
 * 根据累积的 token 数量计算 DeepSeek 总费用（¥ 人民币）。
 * 使用模型每 1M token 定价；对于不在价格表中的模型回退到保守估算。
 */
export function computeCostCNY(
  modelId: string | undefined,
  input: number,
  output: number,
  cacheRead: number,
): number {
  const pricing = (modelId && DEEPSEEK_PRICING[modelId]) || FALLBACK_DEEPSEEK_PRICING;
  const hitCost  = (cacheRead / 1_000_000) * pricing.cacheHit;
  const missCost = (input     / 1_000_000) * pricing.cacheMiss;
  const outCost  = (output    / 1_000_000) * pricing.output;
  return hitCost + missCost + outCost;
}

// ---------------------------------------------------------------------------
// Token 数量格式化（紧凑，与原生页脚一致）
// ---------------------------------------------------------------------------

/** 格式化 token 数量用于紧凑的页脚显示 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

// ---------------------------------------------------------------------------
// 用量统计格式化（页脚风格）
// ---------------------------------------------------------------------------

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
  cost?: number;
  contextTokens?: number;
  turns?: number;
}

/**
 * 以紧凑页脚风格格式化用量统计：
 *   1 turn ↑1.2k ↓800 R500 92.7% ¥0.03 ctx:64k
 *
 * 对于 deepseek 模型使用人民币（¥），其他模型回退到传入的 cost（$）。
 */
export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);

  // 缓存命中率
  const totalPrompt = usage.input + usage.cacheRead;
  if (usage.cacheRead > 0 && totalPrompt > 0) {
    const hitRate = (usage.cacheRead / totalPrompt) * 100;
    parts.push(`${hitRate.toFixed(1)}%`);
  }

  // 费用：deepseek 模型用 ¥，其他用 $
  if (model && model.startsWith("deepseek-")) {
    const costCNY = computeCostCNY(model, usage.input, usage.output, usage.cacheRead);
    if (costCNY > 0) parts.push(`¥${costCNY.toFixed(2)}`);
  } else if (usage.cost && usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`);
  }

  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }

  if (model) parts.push(model);

  return parts.join(" ");
}

/**
 * 聚合多个用量统计。
 */
export function aggregateUsage(results: UsageStats[]): UsageStats {
  const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
  for (const r of results) {
    total.input += r.input;
    total.output += r.output;
    total.cacheRead += r.cacheRead;
    total.cacheWrite = (total.cacheWrite ?? 0) + (r.cacheWrite ?? 0);
    total.cost = (total.cost ?? 0) + (r.cost ?? 0);
    total.turns = (total.turns ?? 0) + (r.turns ?? 0);
    total.contextTokens = Math.max(total.contextTokens ?? 0, r.contextTokens ?? 0);
  }
  return total;
}
