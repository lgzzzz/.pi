/**
 * Cache Hit Rate Notification Extension
 *
 * Shows cache hit rate via notify after each assistant response.
 * Toggle with /cache-stats command.
 */

import type { AssistantMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fmt(n: number): string {
	return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		if (event.message.role !== "assistant") return;

		const usage = (event.message as AssistantMessage).usage;
		const { input, output, cacheRead, cacheWrite } = usage;
		const total = input + cacheRead + cacheWrite;
		if (total === 0) return;

		const rate = Math.round((cacheRead / total) * 100);
		ctx.ui.notify(
			`⚡ Cache: ${rate}% | ↑${fmt(input)} ↓${fmt(output)} cache:${fmt(cacheRead)} write:${fmt(cacheWrite)}`,
			"info",
		);
	});

	pi.registerCommand("cache-stats", {
		description: "Toggle cache hit rate notifications",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Cache stats: ${enabled ? "on" : "off"}`, "info");
		},
	});
}