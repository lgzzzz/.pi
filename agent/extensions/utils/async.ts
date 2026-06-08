/**
 * 异步并发控制工具
 *
 * 从 subagent/index.ts 中提取，提供带并发限制的异步映射操作。
 */

/**
 * 对数组中的每个元素执行异步操作，限制同时进行的最大并发数。
 * 保持结果的原始顺序。
 *
 * @param items - 输入数组
 * @param concurrency - 最大并发数
 * @param fn - 对每个元素执行的异步函数
 * @returns 按原始顺序排列的结果数组
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length) return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}
