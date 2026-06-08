/**
 * 子进程调用工具
 *
 * 从 subagent/index.ts 中提取，提供 pi 子进程的调用和临时文件写入。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/**
 * 推断如何调用 pi 命令行工具。
 * 优先使用当前脚本路径（如果可用），其次使用 execPath 直接调用（如果是 Bun/Node 运行），
 * 最后回退到 shell 中的 "pi" 命令。
 */
export function getPiInvocation(args: string[]): {
    command: string;
    args: string[];
} {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }

    return { command: "pi", args };
}

/**
 * 将提示内容写入临时 Markdown 文件，返回临时目录和文件路径。
 * 调用者负责在最终清理临时目录和文件。
 */
export async function writePromptToTempFile(
    agentName: string,
    prompt: string,
): Promise<{ dir: string; filePath: string }> {
    const tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pi-subagent-"),
    );
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, {
            encoding: "utf-8",
            mode: 0o600,
        });
    });
    return { dir: tmpDir, filePath };
}
