import {
	AbstractInputSuggest,
	prepareFuzzySearch,
	TFolder,
	type App,
} from "obsidian";

/**
 * 给文本输入框绑定 vault 文件夹候选列表：输入时弹出下拉，支持模糊过滤与点选。
 * 交互逻辑参考 lexis 的 FolderSuggest（addSearch + AbstractInputSuggest）。
 * 建议项类型用 string（文件夹路径），点选后通过 onPick 回传完整路径，由调用方触发 onChange 保存。
 */
export class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement | HTMLDivElement,
		private readonly onPick: (folder: string) => void,
	) {
		super(app, inputEl);
		this.limit = 50;
	}

	protected getSuggestions(query: string): string[] {
		const folders = this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.map((f) => f.path);
		const value = query.trim();
		if (!value) {
			return folders.slice(0, this.limit);
		}
		const match = prepareFuzzySearch(value);
		return folders
			.filter((p) => match(p))
			.slice(0, this.limit);
	}

	renderSuggestion(path: string, element: HTMLElement): void {
		const name = path.split("/").pop() || path;
		element.createDiv({ cls: "nihong-ai-file-suggest-name", text: name });
		element.createDiv({ cls: "nihong-ai-file-suggest-path", text: path });
	}

	selectSuggestion(path: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue(path);
		this.close();
		this.onPick(path);
	}
}
