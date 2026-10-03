import { FileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { extractEpubMetadata } from "./epub";

/** 视图类型 id：用于 registerView / registerExtensions */
export const EPUB_VIEW_TYPE = "nihong-ai-epub-view";

export interface EpubViewOptions {
	/** 点击「转换为 md」时触发的回调 */
	onConvert: (file: TFile) => void;
}

/**
 * epub 文件视图：让 Obsidian 能识别并打开 epub（配合 registerExtensions）。
 * 打开后展示书名/作者与「转换为 md」按钮，不渲染正文。
 */
export class EpubView extends FileView {
	private readonly onConvert: (file: TFile) => void;
	private meta: { title: string; author: string } | null = null;

	constructor(leaf: WorkspaceLeaf, opts: EpubViewOptions) {
		super(leaf);
		this.onConvert = opts.onConvert;
		this.icon = "document";
	}

	getViewType(): string {
		return EPUB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.meta?.title || this.file?.basename || "epub 文档";
	}

	override async onLoadFile(file: TFile): Promise<void> {
		this.meta = null;
		// 读取书名/作者用于展示
		try {
			const buf = await this.app.vault.adapter.readBinary(file.path);
			this.meta = extractEpubMetadata(buf);
		} catch {
			// 元数据读取失败不阻塞视图
		}
		this.render();
	}

	override onClose(): Promise<void> {
		this.contentEl.empty();
		return super.onClose();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("nihong-ai-epub-view");

		const title = el.createEl("h2", { cls: "nihong-ai-epub-title" });
		title.setText(this.meta?.title || this.file?.basename || "epub 文档");
		if (this.meta?.author) {
			el.createEl("div", {
				cls: "nihong-ai-epub-author",
				text: `作者：${this.meta.author}`,
			});
		}

		el.createEl("p", {
			cls: "nihong-ai-epub-hint",
			text: "epub 文件不支持直接预览，可转换为 Markdown 后阅读。",
		});

		const btn = el.createEl("button", {
			cls: "nihong-ai-epub-convert-btn",
			text: "转换为 md",
		});
		btn.addEventListener("click", () => {
			const file = this.file;
			if (file) {
				this.onConvert(file);
			}
		});
	}
}
