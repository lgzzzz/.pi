/**
 * DeepSeek Footer 扩展
 *
 * 为 DeepSeek 模型替换 pi 内置的页脚，提供：
 * - 以 ¥（人民币）而非 $ 显示费用
 * - 提示缓存命中率
 *
 * 非 DeepSeek 模型继续使用 pi 内置的页脚。
 *
 * 实现了所有原生页脚功能：
 * - 带 ~ 主目录和 git 分支的工作目录
 * - 会话名称
 * - 输入/输出/缓存读取/写入 token 统计
 * - 费用（转换为人民币）
 * - 缓存命中率
 * - 上下文使用百分比
 * - 带思维级别的模型名称
 * - 多提供商指示器
 * - 自动压缩指示器
 * - 来自 ctx.ui.setStatus() 的扩展状态
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { computeCostCNY, formatTokens } from "./utils/tokens.js";

/** 清理文本以在单行状态中显示（与原生页脚一致） */
function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** 将工作目录格式化为带 ~ 的主目录（与原生页脚一致） */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** 检查模型是否属于 DeepSeek 提供商 */
function isDeepSeekModel(provider: string | undefined): boolean {
  return provider === "deepseek";
}

export default function (pi: ExtensionAPI) {
  // 由事件更新的可变状态
  let currentModel: any = undefined;
  let currentThinkingLevel = "off";

  // 从扩展上下文中捕获（同一对象在会话期间持续存在）
  let capturedSessionManager:  any = undefined;
  let capturedModelRegistry: any = undefined;
  let capturedGetContextUsage: (() => any) | undefined;

  /** 设置自定义页脚。ctx 必须来自有效的扩展事件处理器。 */
  function setCustomFooter(ctx: ExtensionContext) {
    capturedSessionManager = ctx.sessionManager;
    capturedModelRegistry = ctx.modelRegistry;
    capturedGetContextUsage = () => ctx.getContextUsage();

    ctx.ui.setFooter((_tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      // 订阅分支变更以便页脚重新渲染
      const unsub = footerData.onBranchChange(() => _tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {
          // 无需失效
        },
        render(width: number): string[] {
          const sessionMgr = capturedSessionManager;
          const modelReg = capturedModelRegistry;
          const getContextUsage = capturedGetContextUsage;
          if (!sessionMgr) return [];

          // ---- Token 统计（累积，与原生页脚一致） ----
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          for (const entry of sessionMgr.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const msg = entry.message as AssistantMessage;
              totalInput += msg.usage.input;
              totalOutput += msg.usage.output;
              totalCacheRead += msg.usage.cacheRead;

            }
          }

          // 根据 token 数量计算实际人民币费用（而非 pi 的美元估算）
          const costCNY = computeCostCNY(
            currentModel?.id,
            totalInput,
            totalOutput,
            totalCacheRead,
          );

          // ---- 上下文使用情况 ----
          const contextUsage = getContextUsage?.();
          const contextWindow =
            contextUsage?.contextWindow ?? currentModel?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent !== null
              ? contextPercentValue.toFixed(1)
              : "?";

          // ---- 工作目录 / 分支 / 会话名称 ----
          let pwdLabel = formatCwdForFooter(
            sessionMgr.getCwd() ?? "",
            process.env.HOME || process.env.USERPROFILE,
          );
          const branch = footerData.getGitBranch();
          if (branch) {
            pwdLabel = `${pwdLabel} (${branch})`;
          }
          const sessionName = sessionMgr.getSessionName();
          if (sessionName) {
            pwdLabel = `${pwdLabel} • ${sessionName}`;
          }

          // ---- 构建统计行 ----
          const statsParts: string[] = [];

          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);

          // 缓存命中率
          const totalPromptTokens = totalInput + totalCacheRead;
          if (totalCacheRead > 0 && totalPromptTokens > 0) {
            const hitRate = (totalCacheRead / totalPromptTokens) * 100;
            statsParts.push(`${hitRate.toFixed(1)}%`);
          }

          // 人民币费用（根据 token 数量 × 各模型定价计算）
          const usingSubscription = currentModel
            ? modelReg?.isUsingOAuth?.(currentModel) ?? false
            : false;
          if (costCNY > 0 || usingSubscription) {
            const subLabel = usingSubscription ? " (sub)" : "";
            statsParts.push(`¥${costCNY.toFixed(2)}${subLabel}`);
          }

          // 带自动压缩指示器的上下文百分比
          const contextDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)}`
              : `${contextPercent}%/${formatTokens(contextWindow)}`;

          let contextStr: string;
          if (contextPercentValue > 90) {
            contextStr = theme.fg("error", contextDisplay);
          } else if (contextPercentValue > 70) {
            contextStr = theme.fg("warning", contextDisplay);
          } else {
            contextStr = contextDisplay;
          }
          statsParts.push(contextStr);

          let statsLeft = statsParts.join(" ");

          // ---- 右侧显示模型名称 ----
          const modelId = currentModel?.id || "no-model";
          let rightSide: string;
          {
            let rightWithoutProvider = modelId;
            if (currentModel?.reasoning) {
              const level = currentThinkingLevel || "off";
              rightWithoutProvider =
                level === "off"
                  ? `${modelId} • thinking off`
                  : `${modelId} • ${level}`;
            }
            const providerCount =
              footerData.getAvailableProviderCount?.() ?? 1;
            if (providerCount > 1 && currentModel) {
              rightSide = `(${currentModel.provider}) ${rightWithoutProvider}`;
              if (
                visibleWidth(statsLeft) +
                  2 +
                  visibleWidth(rightSide) >
                width
              ) {
                rightSide = rightWithoutProvider;
              }
            } else {
              rightSide = rightWithoutProvider;
            }
          }

          // ---- 布局 ----
          const statsLeftWidth = visibleWidth(statsLeft);
          const rightSideWidth = visibleWidth(rightSide);

          let statsLine: string;
          if (statsLeftWidth + 2 + rightSideWidth <= width) {
            const padding = " ".repeat(
              width - statsLeftWidth - rightSideWidth,
            );
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(
                rightSide,
                availableForRight,
                "",
              );
              const truncatedWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(
                Math.max(0, width - statsLeftWidth - truncatedWidth),
              );
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = truncateToWidth(statsLeft, width, "...");
            }
          }

          // 对部分内容应用 dim（与原生页脚相同的方式）
          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);

          const pwdLine = truncateToWidth(
            theme.fg("dim", pwdLabel),
            width,
            theme.fg("dim", "..."),
          );

          const lines: string[] = [pwdLine, dimStatsLeft + dimRemainder];

          // 扩展状态
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries() as IterableIterator<[string, string]>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });
  }

  /** 根据当前活动模型在自定义页脚和内置页脚之间切换 */
  function maybeSwapFooter(ctx: ExtensionContext) {
    if (isDeepSeekModel(ctx.model?.provider)) {
      setCustomFooter(ctx);
    } else {
      ctx.ui.setFooter(undefined);
    }
  }

  // ---- 会话生命周期 ----
  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model;
    currentThinkingLevel = pi.getThinkingLevel();
    maybeSwapFooter(ctx);
  });

  // ---- 模型变更 ----
  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    // 仅在切换至/自 DeepSeek 时重新评估
    const wasDeepSeek = isDeepSeekModel(event.previousModel?.provider);
    const isDeepSeek = isDeepSeekModel(event.model?.provider);
    if (wasDeepSeek !== isDeepSeek) {
      maybeSwapFooter(ctx);
    }
  });

  // ---- 思维级别变更 ----
  pi.on("thinking_level_select", (event) => {
    currentThinkingLevel = event.level;
  });
}
