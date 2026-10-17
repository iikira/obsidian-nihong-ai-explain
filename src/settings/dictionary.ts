import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** 「词典与显示」分组：词典卡片字号、禁用 Lexis 悬浮窗。 */
export function renderDictionarySection(ctx: SettingsContext, body: HTMLElement): void {
	new Setting(body)
		.setName("词典卡片字号")
		.setDesc("词典卡片正文基础字号（px），范围为 8–32，默认 0（使用 Obsidian 主题默认值）。修改后新打开的卡片生效。")
		.addText((text) =>
			text
				.setPlaceholder("0")
				.setValue(String(ctx.plugin.settings.dictFontSize))
				.onChange(async (value) => {
					const n = Number(value);
					if (
						Number.isFinite(n) &&
						(n === 0 || (n >= 8 && n <= 32))
					) {
						ctx.plugin.settings.dictFontSize = n;
						await ctx.plugin.saveSettings();
						text.inputEl.setCssStyles({ borderColor: "" });
					} else {
						text.inputEl.setCssStyles({
							borderColor: "var(--text-error)",
						});
					}
				}),
		);
	new Setting(body)
		.setName("禁用 Lexis 悬浮窗")
		.setDesc("开启后完全阻止 Lexis 选区悬浮窗弹出，改用本插件自带悬浮按钮。需重新选词生效。")
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.plugin.settings.disableLexisPill)
				.onChange(async (value) => {
					ctx.plugin.settings.disableLexisPill = value;
					await ctx.plugin.saveSettings();
					ctx.plugin.applyLexisPillDisabled();
				}),
		);
}
