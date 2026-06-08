/**
 * 工具调用格式化
 *
 * 将子代理执行过程中的工具调用（bash、read、write 等）
 * 格式化为可读的短文本，用于 TUI 渲染。
 */

import * as os from "node:os";

// ---------------------------------------------------------------------------
// 路径缩写
// ---------------------------------------------------------------------------

/** 将绝对路径缩写为主目录 ~ 前缀形式 */
function shortenPath(p: string): string {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// 格式化常量
// ---------------------------------------------------------------------------

/** bash 命令预览最大长度 */
const COMMAND_PREVIEW_MAX = 60;

/** 未知工具的 JSON 参数预览最大长度 */
const ARGS_PREVIEW_MAX = 50;

// ---------------------------------------------------------------------------
// 主格式化函数
// ---------------------------------------------------------------------------

/**
 * 格式化单个工具调用为可读的单行文本。
 *
 * @param toolName 工具名称（如 "bash"、"read"、"write" 等）
 * @param args     工具调用参数
 * @param themeFg  主题着色函数
 * @returns 格式化后的带颜色单行文本
 */
export function formatToolCall(
    toolName: string,
    args: Record<string, unknown>,
    themeFg: (color: string, text: string) => string,
): string {
    switch (toolName) {
        case "bash": {
            const command = (args.command as string) || "...";
            const preview =
                command.length > COMMAND_PREVIEW_MAX
                    ? `${command.slice(0, COMMAND_PREVIEW_MAX)}...`
                    : command;
            return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
        }

        case "read": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;

            let text = themeFg("accent", filePath);
            if (offset !== undefined || limit !== undefined) {
                const startLine = offset ?? 1;
                const endLine =
                    limit !== undefined ? startLine + limit - 1 : "";
                text += themeFg(
                    "warning",
                    `:${startLine}${endLine ? `-${endLine}` : ""}`,
                );
            }
            return themeFg("muted", "read ") + text;
        }

        case "write": {
            const rawPath = (args.file_path || args.path || "...") as string;
            const filePath = shortenPath(rawPath);
            const content = (args.content || "") as string;
            const lines = content.split("\n").length;

            let text =
                themeFg("muted", "write ") + themeFg("accent", filePath);
            if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
            return text;
        }

        case "edit": {
            const rawPath = (args.file_path || args.path || "...") as string;
            return (
                themeFg("muted", "edit ") +
                themeFg("accent", shortenPath(rawPath))
            );
        }

        case "ls": {
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath))
            );
        }

        case "find": {
            const pattern = (args.pattern || "*") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "find ") +
                themeFg("accent", pattern) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }

        case "grep": {
            const pattern = (args.pattern || "") as string;
            const rawPath = (args.path || ".") as string;
            return (
                themeFg("muted", "grep ") +
                themeFg("accent", `/${pattern}/`) +
                themeFg("dim", ` in ${shortenPath(rawPath)}`)
            );
        }

        default: {
            const argsStr = JSON.stringify(args);
            const preview =
                argsStr.length > ARGS_PREVIEW_MAX
                    ? `${argsStr.slice(0, ARGS_PREVIEW_MAX)}...`
                    : argsStr;
            return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
        }
    }
}