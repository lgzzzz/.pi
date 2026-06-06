/**
 * Token 用量持久化存储
 *
 * 提供 token-usage.json 文件的读写操作。
 * 数据按 sessionId → {"provider/modelId": ModelTokenUsage} 组织。
 *
 * 提取自 deepseek-utils.ts，供 token-tracker 使用。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface ModelTokenUsage {
  /** 未缓存输入 token（cache miss） */
  uncachedInputTokens: number;
  /** 已缓存输入 token（cache hit） */
  cachedInputTokens: number;
  /** 输出 token */
  outputTokens: number;
}

/** 每个会话的条目：key 为 "provider/modelId"，value 为累计 token */
export type SessionEntry = Record<string, ModelTokenUsage>;

/** 顶层存储：sessionId → SessionEntry */
export type TokenUsageStore = Record<string, SessionEntry>;

// ---------------------------------------------------------------------------
// 键名构建
// ---------------------------------------------------------------------------

/** 构建 "provider/modelId" 键名 */
export function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/** 默认存储文件名（相对于工作目录） */
export const TOKEN_USAGE_FILE = ".pi/token-usage.json";

/** 从文件加载 token 用量存储 */
export function loadTokenUsageStore(filePath: string): TokenUsageStore {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as TokenUsageStore;
  } catch {
    return {};
  }
}

/** 将 token 用量存储写入文件 */
export function saveTokenUsageStore(filePath: string, store: TokenUsageStore): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}
