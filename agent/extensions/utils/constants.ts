/**
 * 共享常量
 *
 * 从 subagent/index.ts 中提取，供 subagent 和其他扩展使用。
 */

/** 最大并行任务数 */
export const MAX_PARALLEL_TASKS = 8;

/** 最大并发数（同时运行的子代理实例数） */
export const MAX_CONCURRENCY = 4;

/** 折叠视图默认显示的项数 */
export const COLLAPSED_ITEM_COUNT = 10;

/** 每个并行任务输出的最大字节数（超出截断） */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
