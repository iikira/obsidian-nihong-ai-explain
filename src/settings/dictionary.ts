import { Platform, Setting } from "obsidian";
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

	// 移动端专属：悬浮窗固定底部 + 距底端距离（桌面端跟随选区，不显示这两行）
	if (Platform.isMobileApp) {
		new Setting(body)
			.setName("悬浮窗固定底部")
			.setDesc("开启：悬浮按钮固定在屏幕底部居中，不跟随选区；关闭：跟随选区位置。需重新选词生效。")
			.addToggle((toggle) =>
				toggle
					.setValue(ctx.plugin.settings.mobileFixedPill)
					.onChange(async (value) => {
						ctx.plugin.settings.mobileFixedPill = value;
						await ctx.plugin.saveSettings();
						ctx.plugin.applyMobileFixedPill();
					}),
			);
		new Setting(body)
			.setName("悬浮窗距底端距离 (px)")
			.setDesc("固定在底部时距屏幕底端的距离（像素）。仅「悬浮窗固定底部」开启时生效。")
			.addText((text) =>
				text
					.setPlaceholder("100")
					.setValue(String(ctx.plugin.settings.mobileFixedPillBottom))
					.onChange(async (value) => {
						const n = Math.max(0, Math.floor(Number(value) || 0));
						ctx.plugin.settings.mobileFixedPillBottom = n;
						await ctx.plugin.saveSettings();
						ctx.plugin.applyMobileFixedPill();
					}),
			);
	}
}
