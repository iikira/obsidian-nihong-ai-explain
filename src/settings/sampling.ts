import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** 「采样参数」分组：温度、最大重试、重试间隔、请求超时、翻译目标语言。 */
export function renderSamplingSection(ctx: SettingsContext, body: HTMLElement): void {
	new Setting(body)
		.setName("温度 (temperature)")
		.addText((text) =>
			text
				.setPlaceholder("0.7")
				.setValue(String(ctx.plugin.settings.temperature))
				.onChange(async (value) => {
					const n = Number(value);
					if (!isNaN(n)) {
						ctx.plugin.settings.temperature = n;
						await ctx.plugin.saveSettings();
					}
				}),
		);
	new Setting(body)
		.setName("最大重试次数")
		.addText((text) =>
			text
				.setPlaceholder("3")
				.setValue(String(ctx.plugin.settings.maxRetries))
				.onChange(async (value) => {
					const n = Math.max(0, Math.floor(Number(value) || 0));
					ctx.plugin.settings.maxRetries = n;
					await ctx.plugin.saveSettings();
				}),
		);
	new Setting(body)
		.setName("重试间隔 (毫秒)")
		.addText((text) =>
			text
				.setPlaceholder("2000")
				.setValue(String(ctx.plugin.settings.retryInterval))
				.onChange(async (value) => {
					const n = Math.max(0, Math.floor(Number(value) || 0));
					ctx.plugin.settings.retryInterval = n;
					await ctx.plugin.saveSettings();
				}),
		);
	new Setting(body)
		.setName("单次请求超时 (毫秒)")
		.addText((text) =>
			text
				.setPlaceholder("120000")
				.setValue(String(ctx.plugin.settings.requestTimeout))
				.onChange(async (value) => {
					const n = Math.max(1000, Math.floor(Number(value) || 0));
					ctx.plugin.settings.requestTimeout = n;
					await ctx.plugin.saveSettings();
				}),
		);
	new Setting(body)
		.setName("翻译目标语言")
		.setDesc("翻译功能的目标语言，如「中文」「英文」等。")
		.addText((text) =>
			text
				.setPlaceholder("中文")
				.setValue(ctx.plugin.settings.targetLanguage)
				.onChange(async (value) => {
					ctx.plugin.settings.targetLanguage = value.trim() || "中文";
					await ctx.plugin.saveSettings();
				}),
		);
}
