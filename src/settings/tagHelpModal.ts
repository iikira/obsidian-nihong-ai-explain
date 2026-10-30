import { Modal, App } from "obsidian";
import { JITENDEX_TAG_DOCS } from "../dictionary/jitendexTags";

/**
 * 词典 tag 中文解释帮助弹窗：展示一个表格，列出 Jitendex 词典的所有 tag 及其中文解释。
 * 按 group（词性 / 描述）分节，表格两列：tag 原名 + 中文解释。
 * 点击设置页「查看词典使用方法」按钮打开。
 */
export class TagHelpModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Jitendex 词典 tag 说明");
		contentEl.addClass("nihong-ai-tag-help");

		contentEl.createEl("p", {
			cls: "nihong-ai-tag-help-hint",
			text: "Jitendex 词典在查询结果里用这些 tag 标注词性/用法。点击 tag 可复制。下面按分类列出全部 tag 及其中文解释。",
		});

		// 按 group 分节
		const groups = new Map<string, typeof JITENDEX_TAG_DOCS>();
		for (const doc of JITENDEX_TAG_DOCS) {
			const arr = groups.get(doc.group);
			if (arr) {
				arr.push(doc);
			} else {
				groups.set(doc.group, [doc]);
			}
		}

		for (const [groupName, docs] of groups) {
			const section = contentEl.createDiv({ cls: "nihong-ai-tag-help-section" });
			section.createEl("h3", { text: groupName });
			const table = section.createEl("table", { cls: "nihong-ai-tag-help-table" });
			const thead = table.createEl("thead");
			const headRow = thead.createEl("tr");
			headRow.createEl("th", { text: "tag" });
			headRow.createEl("th", { text: "中文解释" });
			const tbody = table.createEl("tbody");
			for (const doc of docs) {
				const row = tbody.createEl("tr");
				row.createEl("td", { text: doc.tag });
				row.createEl("td", { text: doc.zh });
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
