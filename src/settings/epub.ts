import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/**
 * 「epub 转换」分组：epub → Markdown 转换相关的开关。
 * 当前仅一个开关：转换后是否保留振假名（<ruby><rt> 注音标签）。
 */
export function renderEpubSection(ctx: SettingsContext, body: HTMLElement): void {
	new Setting(body)
		.setName("保留振假名")
		.setDesc(
			"开启：转换后保留 <ruby><rt> 注音标签（Obsidian 阅读视图可显示注音）；" +
			"关闭：剥离注音，只保留基底汉字。下次转换 epub 生效。",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.plugin.settings.epubPreserveRuby)
				.onChange(async (value) => {
					ctx.plugin.settings.epubPreserveRuby = value;
					await ctx.plugin.saveSettings();
				}),
		);
}
