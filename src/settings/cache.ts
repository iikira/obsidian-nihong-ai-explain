import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { clearTTSCache, getTTSCacheSize } from "../tts";

/** 更新「TTS 缓存」行的描述条数 */
const ttsDesc = (n: number): string =>
	`LRU 缓存 TTS 音频，容量 128 条。当前 ${n} 条。`;

/** 更新「翻译缓存」行的描述条数 */
const translateDesc = (n: number): string =>
	`LRU 缓存翻译结果，容量 1024 条。当前 ${n} 条。`;

/** 「缓存管理」分组：TTS 缓存 + 翻译缓存，各带「清空缓存」按钮。 */
export function renderCacheSection(ctx: SettingsContext, body: HTMLElement): void {
	const ttsSetting = new Setting(body)
		.setName("TTS 缓存")
		.setDesc(ttsDesc(getTTSCacheSize()))
		.addButton((btn) =>
			btn
				.setButtonText("清空缓存")
				.setDestructive()
				.onClick(() => {
					void clearTTSCache().then(() => {
						new Notice("TTS 缓存已清空");
						// 只更新本行描述条数，不重渲染整个设置树（避免焦点重置到首个输入框触发下拉）
						ttsSetting.setDesc(ttsDesc(getTTSCacheSize()));
					});
				}),
		);

	const translateSize = (): number => ctx.plugin.translateCache?.size() ?? 0;
	const translateSetting = new Setting(body)
		.setName("翻译缓存")
		.setDesc(translateDesc(translateSize()))
		.addButton((btn) =>
			btn
				.setButtonText("清空缓存")
				.setDestructive()
				.onClick(() => {
					ctx.plugin.translateCache?.clear();
					new Notice("已清空翻译缓存");
					translateSetting.setDesc(translateDesc(translateSize()));
				}),
		);
}

