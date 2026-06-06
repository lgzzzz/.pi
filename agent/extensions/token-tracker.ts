/**
 * Token Tracker Extension
 *
 * Tracks per-session, per-model token consumption and persists it to
 * .pi/token-usage.json. Provides a /status command to summarize all
 * DeepSeek token consumption with RMB cost calculation.
 *
 * Data structure (per session):
 *   sessionId → { "provider/modelId": { uncachedInputTokens, cachedInputTokens, outputTokens } }
 *
 * Pricing source: DeepSeek official API pricing (¥ / 1M tokens)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { DEEPSEEK_PRICING, FALLBACK_DEEPSEEK_PRICING, formatTokens } from "./utils/tokens.js";
import {
  modelKey,
  loadTokenUsageStore,
  saveTokenUsageStore,
  TOKEN_USAGE_FILE as USAGE_FILE,
  type ModelTokenUsage,
  type SessionEntry,
} from "./utils/token-storage.js";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // In-memory accumulator for the current session
  let currentEntry: SessionEntry = {};
  let currentSessionId = "";
  let usageFilePath = "";

  // ------------------------------------------------------------------
  // session_start — load existing data for the current session
  // ------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    usageFilePath = resolve(ctx.cwd, USAGE_FILE);
    currentSessionId = sessionId;

    const store = loadTokenUsageStore(usageFilePath);
    currentEntry = store[sessionId] ? { ...store[sessionId] } : {};
  });

  // ------------------------------------------------------------------
  // message_end — accumulate tokens per model
  // ------------------------------------------------------------------
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    const msg = event.message;
    const usage = msg.usage;
    if (!usage) return;

    const provider = msg.provider ?? "unknown";
    const modelId = msg.model ?? "unknown";
    const key = modelKey(provider, modelId);

    const uncached = usage.input;
    const cached = usage.cacheRead;
    const output = usage.output;

    if (uncached === 0 && cached === 0 && output === 0) return;

    // Initialize model entry if needed
    if (!currentEntry[key]) {
      currentEntry[key] = {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      };
    }

    currentEntry[key].uncachedInputTokens += uncached;
    currentEntry[key].cachedInputTokens += cached;
    currentEntry[key].outputTokens += output;

    // Persist immediately
    const store = loadTokenUsageStore(usageFilePath);
    store[currentSessionId] = currentEntry;
    saveTokenUsageStore(usageFilePath, store);
  });

  // ------------------------------------------------------------------
  // session_shutdown — final persistence
  // ------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    if (!currentSessionId || !usageFilePath) return;
    const store = loadTokenUsageStore(usageFilePath);
    store[currentSessionId] = currentEntry;
    saveTokenUsageStore(usageFilePath, store);
  });

  // ------------------------------------------------------------------
  // /status command — summarize DeepSeek token consumption & RMB cost
  // ------------------------------------------------------------------
  pi.registerCommand("status", {
    description: "Show DeepSeek token consumption summary with RMB cost",
    handler: async (_args, ctx) => {
      const filePath = resolve(ctx.cwd, USAGE_FILE);
      const store = loadTokenUsageStore(filePath);

      // Aggregate all DeepSeek models across all sessions
      const deepseekModels: Map<string, ModelTokenUsage & { sessionCount: number }> = new Map();

      for (const [_sid, entry] of Object.entries(store)) {
        for (const [key, usage] of Object.entries(entry)) {
          if (!key.startsWith("deepseek/")) continue;

          const existing = deepseekModels.get(key);
          if (existing) {
            existing.uncachedInputTokens += usage.uncachedInputTokens;
            existing.cachedInputTokens += usage.cachedInputTokens;
            existing.outputTokens += usage.outputTokens;
            existing.sessionCount += 1;
          } else {
            deepseekModels.set(key, {
              ...usage,
              sessionCount: 1,
            });
          }
        }
      }

      if (deepseekModels.size === 0) {
        ctx.ui.notify("No DeepSeek token consumption recorded yet.", "info");
        return;
      }

      // Build compact footer-style summary (matching deepseek-footer style)
      const lines: string[] = [];
      lines.push("DeepSeek 用量汇总");
      lines.push("─".repeat(70));

      let totalCost = 0;

      for (const [key, usage] of deepseekModels.entries()) {
        const modelId = key.slice("deepseek/".length);
        const pricing = DEEPSEEK_PRICING[modelId] ?? FALLBACK_DEEPSEEK_PRICING;

        const totalInput = usage.uncachedInputTokens+usage.cachedInputTokens;
        const missCost = (usage.uncachedInputTokens / 1_000_000) * pricing.cacheMiss;
        const hitCost  = (usage.cachedInputTokens   / 1_000_000) * pricing.cacheHit;
        const outCost  = (usage.outputTokens        / 1_000_000) * pricing.output;
        const cost = missCost + hitCost + outCost;

        // Build stats in exact deepseek-footer compact style: ↑61k ↓15k R771k 92.7% ¥0.29
        const parts: string[] = [];
        parts.push(`↑${formatTokens(usage.uncachedInputTokens)}`);
        parts.push(`↓${formatTokens(usage.outputTokens)}`);
        if (usage.cachedInputTokens > 0) {
          parts.push(`R${formatTokens(usage.cachedInputTokens)}`);
        }

        // Cache hit rate
        const hitRate = totalInput > 0
          ? (usage.cachedInputTokens / totalInput) * 100
          : 0;
        parts.push(`${hitRate.toFixed(1)}%`);

        // Cost (right-aligned, ¥紧贴数字)
        parts.push(`¥${cost.toFixed(2)}`.padStart(8));

        const modelLabel = modelId.padEnd(18);
        lines.push(`${modelLabel}${parts.join(" ")}`);

        totalCost += cost;
      }

      if (deepseekModels.size > 1) {
        lines.push("─".repeat(70));
        const costStr = `¥${totalCost.toFixed(2)}`.padStart(8);
        lines.push(`合计${costStr.padStart(64)}`);
      }

      // Output via notify
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ------------------------------------------------------------------
  // /reset command — reset all token statistics
  // ------------------------------------------------------------------
  pi.registerCommand("reset", {
    description: "Reset all DeepSeek token consumption statistics",
    handler: async (_args, ctx) => {
      const filePath = resolve(ctx.cwd, USAGE_FILE);

      // Clear in-memory entry
      currentEntry = {};

      // Clear persisted store
      saveTokenUsageStore(filePath, {});

      ctx.ui.notify("Token statistics have been reset.", "info");
    },
  });
}
