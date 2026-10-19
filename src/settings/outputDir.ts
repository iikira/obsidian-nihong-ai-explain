import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { FolderSuggest } from "./folderSuggest";

/**
 * 监听 SearchComponent 的 × 清除按钮：Obsidian 点 × 会清空 input 但不派发 input 事件，
 * 导致 onChange 不执行（值没持久化清空）且 Suggest 候选列表不刷新。
 * 这里在清除后手动派发 input 事件，既触发 onChange 持久化，又让 Suggest 重新弹出候选。
 */
export function bindClearButtonRefresh(search: {
	inputEl: HTMLInputElement;
	clearButtonEl: HTMLElement;
}): void {
	search.clearButtonEl.addEventListener("click", () => {
		window.setTimeout(() => {
			search.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
		}, 0);
	});
}

/** 「输出目录」分组：单词解析 + 语法拆解两个输出目录（文件夹下拉）。 */
export function renderOutputDirSection(ctx: SettingsContext, body: HTMLElement): void {
	new Setting(body)
		.setName("单词解析输出目录")
		.setDesc("单词解析保存到此目录。留空则输出到根目录。")
		.addSearch((search) => {
			const apply = async (value: string): Promise<void> => {
				ctx.plugin.settings.outputDir = value.trim();
				await ctx.plugin.saveSettings();
			};
			search
				.setPlaceholder("单词解析")
				.setValue(ctx.plugin.settings.outputDir)
				.onChange((value) => void apply(value));
			// 输入时弹出 vault 文件夹候选下拉，可过滤与点选（交互参考 lexis）
			// 点选后 setValue 不会触发 onChange，需在 onPick 里直接保存
			new FolderSuggest(ctx.app, search.inputEl, (folder) => {
				search.setValue(folder);
				void apply(folder);
			});
			bindClearButtonRefresh(search);
		});
	new Setting(body)
		.setName("语法拆解输出目录")
		.setDesc("语法拆解笔记保存到此目录。留空则输出到根目录。")
		.addSearch((search) => {
			const apply = async (value: string): Promise<void> => {
				ctx.plugin.settings.grammarOutputDir = value.trim();
				await ctx.plugin.saveSettings();
			};
			search
				.setPlaceholder("语法拆解")
				.setValue(ctx.plugin.settings.grammarOutputDir)
				.onChange((value) => void apply(value));
			new FolderSuggest(ctx.app, search.inputEl, (folder) => {
				search.setValue(folder);
				void apply(folder);
			});
			bindClearButtonRefresh(search);
		});
}
