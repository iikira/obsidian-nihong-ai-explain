import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { clearTTSCache, getTTSCacheSize } from "../tts";

/** 「缓存管理」分组：TTS 缓存 + 翻译缓存，各带「清空缓存」按钮。 */
export function renderCacheSection(ctx: SettingsContext, body: HTMLElement): void {
	new Setting(body)
		.setName("TTS 缓存")
		.setDesc(`LRU 缓存 TTS 音频，容量 128 条。当前 ${getTTSCacheSize()} 条。`)
		.addButton((btn) =>
			btn
				.setButtonText("清空缓存")
				.setWarning()
				.onClick(async () => {
					clearTTSCache();
					new Notice("TTS 缓存已清空");
					ctx.update();
				}),
		);

	new Setting(body)
		.setName("翻译缓存")
		.setDesc(`LRU 缓存翻译结果，容量 1024 条。当前 ${ctx.plugin.translateCache?.size() ?? 0} 条。`)
		.addButton((btn) =>
			btn
				.setButtonText("清空缓存")
				.setWarning()
				.onClick(async () => {
					ctx.plugin.translateCache?.clear();
					new Notice("已清空翻译缓存");
					ctx.update();
				}),
		);
}
