import { ItemView, type WorkspaceLeaf } from "obsidian";
import { logger, type LogEntry, type LogLevel } from "./index";

/** 日志页签视图类型 id */
export const LOG_VIEW_TYPE = "nihong-ai-log-view";

/** 日志级别对应的 CSS 类（用于着色） */
const LEVEL_CLASS: Record<LogLevel, string> = {
	info: "nihong-ai-log-level-info",
	warn: "nihong-ai-log-level-warn",
	error: "nihong-ai-log-level-error",
};

/** 日志级别前缀符号 */
const LEVEL_PREFIX: Record<LogLevel, string> = {
	info: "·",
	warn: "!",
	error: "×",
};

/**
 * 侧边栏日志页签：订阅 logger，实时渲染日志列表。
 * 打开时先渲染已有日志快照，后续新日志实时 append（带时间戳、级别着色）。
 * 顶部「清空」按钮清空日志。
 */
export class LogPanelView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private listEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "scroll-text";
	}

	getViewType(): string {
		return LOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Nihong AI 日志";
	}

	protected async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("nihong-ai-log-view");

		// 顶部工具栏：清空按钮
		const toolbar = contentEl.createDiv({ cls: "nihong-ai-log-toolbar" });
		toolbar.createSpan({ cls: "nihong-ai-log-title", text: "日志" });
		toolbar.createEl(
			"button",
			{ cls: "nihong-ai-log-clear-btn", text: "清空" },
			(btn) => {
				btn.addEventListener("click", () => logger.clear());
			},
		);

		// 日志列表（可滚动、等宽、可选中复制）
		this.listEl = contentEl.createDiv({ cls: "nihong-ai-log-list" });

		// 先渲染已有快照
		for (const entry of logger.getEntries()) {
			this.appendEntry(entry);
		}

		// 订阅新日志
		this.unsubscribe = logger.subscribe((batch) => {
			if (batch.length === 0) {
				// clear() 触发空批次：清空列表
				this.listEl?.empty();
				return;
			}
			for (const entry of batch) {
				this.appendEntry(entry);
			}
			// 自动滚到底部，看最新日志
			if (this.listEl) {
				this.listEl.scrollTop = this.listEl.scrollHeight;
			}
		});
	}

	protected async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listEl = null;
	}

	/** 追加单条日志到列表末尾 */
	private appendEntry(entry: LogEntry): void {
		if (!this.listEl) {
			return;
		}
		const line = this.listEl.createDiv({ cls: "nihong-ai-log-line" });
		line.addClass(LEVEL_CLASS[entry.level]);
		const time = formatTime(entry.ts);
		line.createSpan({ cls: "nihong-ai-log-time", text: time });
		line.createSpan({ cls: "nihong-ai-log-level", text: LEVEL_PREFIX[entry.level] });
		line.createSpan({ cls: "nihong-ai-log-source", text: entry.source });
		line.createSpan({ cls: "nihong-ai-log-text", text: entry.text });
	}
}

/** 时间戳格式化为 HH:MM:SS.mmm */
function formatTime(ts: number): string {
	const d = new Date(ts);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const ms = String(d.getMilliseconds()).padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}
