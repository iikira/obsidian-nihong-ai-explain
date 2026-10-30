import { ItemView, type WorkspaceLeaf } from "obsidian";
import { logger, type LogEntry, type LogLevel } from "./index";
import type { LRUTranslateCache } from "../translate/cache";
import { getTTSCacheEntries, playTTSCacheBlob } from "../tts";
import { subscribeCacheChange } from "../cacheEvents";
import { matchTranslateWithTTS, matchTTSWithTranslate } from "../cacheMatch";

/** 日志页签视图类型 id */
export const LOG_VIEW_TYPE = "nihong-ai-log-view";

/**
 * 日志面板所需宿主接口（避免直接 import 插件类型造成循环依赖）。
 * 插件提供翻译缓存访问。
 */
export interface LogViewHost {
	/** 翻译 LRU 缓存（未初始化翻译服务时为 null） */
	readonly translateCache: LRUTranslateCache | null;
}

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

/** tab id */
type TabId = "log" | "translate" | "tts";

/** tab 定义 */
const TABS: { id: TabId; label: string }[] = [
	{ id: "log", label: "日志" },
	{ id: "translate", label: "翻译缓存" },
	{ id: "tts", label: "朗读缓存" },
];

/**
 * 侧边栏日志页签：三个 tab —— 日志 / 翻译缓存 / 朗读缓存。
 * - 日志：订阅 logger，实时渲染（时间戳、级别着色），顶部「清空」。
 * - 翻译缓存：展示 LRU 翻译缓存条目（原文 → 译文），按最近使用在前。
 * - 朗读缓存：展示 TTS 缓存条目（原文 + 引擎/语音），点击直接播 blob URL。
 *
 * 缓存 tab 在切换到时刷新快照（缓存非实时订阅，按需重渲染）。
 */
export class LogPanelView extends ItemView {
	private host: LogViewHost;
	private unsubscribe: (() => void) | null = null;
	private unsubscribeCache: (() => void) | null = null;
	private logListEl: HTMLElement | null = null;
	private translateListEl: HTMLElement | null = null;
	private ttsListEl: HTMLElement | null = null;
	private activeTab: TabId = "log";
	/** 各 tab 的容器（切换时 show/hide） */
	private panels: Partial<Record<TabId, HTMLElement>> = {};
	private tabButtons: Partial<Record<TabId, HTMLButtonElement>> = {};

	constructor(leaf: WorkspaceLeaf, host: LogViewHost) {
		super(leaf);
		this.host = host;
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

		// 顶部 tab 栏
		const tabBar = contentEl.createDiv({ cls: "nihong-ai-log-tabbar" });
		for (const tab of TABS) {
			const btn = tabBar.createEl("button", {
				cls: "nihong-ai-log-tab",
				text: tab.label,
			});
			btn.addEventListener("click", () => this.switchTab(tab.id));
			this.tabButtons[tab.id] = btn;
		}

		// 日志 tab：工具栏（清空）+ 列表
		const logPanel = contentEl.createDiv({ cls: "nihong-ai-log-panel" });
		const toolbar = logPanel.createDiv({ cls: "nihong-ai-log-toolbar" });
		toolbar.createSpan({ cls: "nihong-ai-log-title", text: "日志" });
		toolbar.createEl(
			"button",
			{ cls: "nihong-ai-log-clear-btn", text: "清空" },
			(btn) => {
				btn.addEventListener("click", () => logger.clear());
			},
		);
		this.logListEl = logPanel.createDiv({ cls: "nihong-ai-log-list" });
		// 先渲染已有快照
		for (const entry of logger.getEntries()) {
			this.appendLogEntry(entry);
		}
		// 订阅新日志
		this.unsubscribe = logger.subscribe((batch) => {
			if (batch.length === 0) {
				this.logListEl?.empty();
				return;
			}
			for (const entry of batch) {
				this.appendLogEntry(entry);
			}
			if (this.logListEl) {
				this.logListEl.scrollTop = this.logListEl.scrollHeight;
			}
		});
		this.panels.log = logPanel;

		// 翻译缓存 tab（无刷新按钮：缓存写入/清空后由 cacheEvents 自动通知刷新）
		const translatePanel = contentEl.createDiv({ cls: "nihong-ai-log-panel" });
		this.translateListEl = translatePanel.createDiv({ cls: "nihong-ai-log-list" });
		this.panels.translate = translatePanel;

		// 朗读缓存 tab（无刷新按钮：缓存写入/清空后由 cacheEvents 自动通知刷新）
		const ttsPanel = contentEl.createDiv({ cls: "nihong-ai-log-panel" });
		this.ttsListEl = ttsPanel.createDiv({ cls: "nihong-ai-log-list" });
		this.panels.tts = ttsPanel;

		// 订阅缓存变更：任一缓存变更都刷新两个缓存 tab（朗读/翻译后、设置页清空缓存后），
		// 这样在朗读缓存 tab 时翻译出新结果，朗读缓存行也能实时显示译文；反之亦然。
		// 非可见 tab 的 DOM 已存在（只是 display:none），刷新它不影响可见 tab。
		this.unsubscribeCache = subscribeCacheChange(() => {
			this.renderTranslateCache();
			this.renderTTSCache();
		});

		// 默认激活日志 tab
		this.switchTab("log");
	}

	protected async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeCache?.();
		this.unsubscribeCache = null;
		this.logListEl = null;
		this.translateListEl = null;
		this.ttsListEl = null;
		this.panels = {};
		this.tabButtons = {};
	}

	/** 切换 tab：更新按钮高亮、显示对应面板；缓存 tab 切入时刷新快照 */
	private switchTab(tab: TabId): void {
		this.activeTab = tab;
		for (const t of TABS) {
			const btn = this.tabButtons[t.id];
			if (btn) {
				btn.classList.toggle("is-active", t.id === tab);
			}
			const panel = this.panels[t.id];
			if (panel) {
				panel.style.display = t.id === tab ? "" : "none";
			}
		}
		if (tab === "translate") {
			this.renderTranslateCache();
		} else if (tab === "tts") {
			this.renderTTSCache();
		}
	}

	/** 追加单条日志到列表末尾 */
	private appendLogEntry(entry: LogEntry): void {
		if (!this.logListEl) {
			return;
		}
		const line = this.logListEl.createDiv({ cls: "nihong-ai-log-line" });
		line.addClass(LEVEL_CLASS[entry.level]);
		const time = formatTime(entry.ts);
		line.createSpan({ cls: "nihong-ai-log-time", text: time });
		line.createSpan({ cls: "nihong-ai-log-level", text: LEVEL_PREFIX[entry.level] });
		line.createSpan({ cls: "nihong-ai-log-source", text: entry.source });
		line.createSpan({ cls: "nihong-ai-log-text", text: entry.text });
	}

	/** 渲染翻译缓存条目（最近使用在前）；能命中朗读缓存的条目加 ▶ 朗读按钮 */
	private renderTranslateCache(): void {
		if (!this.translateListEl) {
			return;
		}
		this.translateListEl.empty();
		const cache = this.host.translateCache;
		if (!cache) {
			this.translateListEl.createDiv({
				cls: "nihong-ai-log-empty",
				text: "翻译服务未初始化",
			});
			return;
		}
		const entries = cache.entries();
		if (entries.length === 0) {
			this.translateListEl.createDiv({ cls: "nihong-ai-log-empty", text: "暂无缓存" });
			return;
		}
		// 命中朗读缓存：按 text 关联，命中的条目行首加 ▶ + 整行点击播放（复用朗读缓存的操作逻辑）
		const matched = matchTranslateWithTTS(entries, getTTSCacheEntries());
		for (const e of matched) {
			const line = this.translateListEl.createDiv({ cls: "nihong-ai-log-cache-line" });
			// 命中朗读缓存：行首 ▶ 图标 + 整行可点击播放（与朗读缓存行一致的交互）
			if (e.ttsBlobUrl) {
				const blobUrl = e.ttsBlobUrl;
				line.addClass("nihong-ai-log-tts-playable");
				line.createSpan({ cls: "nihong-ai-log-tts-play", text: "▶" });
				line.addEventListener("click", () => {
					playTTSCacheBlob(blobUrl);
				});
			}
			const head = line.createDiv({ cls: "nihong-ai-log-cache-head" });
			head.createSpan({ cls: "nihong-ai-log-cache-src", text: e.text });
			if (e.target) {
				head.createSpan({ cls: "nihong-ai-log-cache-tag", text: `→ ${e.target}` });
			}
			line.createDiv({ cls: "nihong-ai-log-cache-val", text: e.value });
		}
	}

	/** 渲染朗读缓存条目（最近使用在前）；点击行直接播 blob URL；命中翻译缓存则展示译文 */
	private renderTTSCache(): void {
		if (!this.ttsListEl) {
			return;
		}
		this.ttsListEl.empty();
		const entries = getTTSCacheEntries();
		if (entries.length === 0) {
			this.ttsListEl.createDiv({ cls: "nihong-ai-log-empty", text: "暂无缓存" });
			return;
		}
		// 命中翻译缓存：按 text 关联，命中的条目展示译文
		const translateEntries = this.host.translateCache?.entries() ?? [];
		const matched = matchTTSWithTranslate(entries, translateEntries);
		for (const e of matched) {
			const line = this.ttsListEl.createDiv({ cls: "nihong-ai-log-cache-line nihong-ai-log-tts-line" });
			line.createSpan({ cls: "nihong-ai-log-tts-play", text: "▶" });
			const meta = line.createDiv({ cls: "nihong-ai-log-tts-meta" });
			meta.createSpan({ cls: "nihong-ai-log-cache-src", text: e.text });
			// 仅显示引擎标签（Google/Edge/Windows）；voice 短名（如 ja-JP-NanamiNeural）对用户无意义，不展示
			meta.createSpan({ cls: "nihong-ai-log-cache-tag nihong-ai-log-tts-engine", text: engineLabel(e.engine) });
			// 命中翻译缓存：展示译文
			if (e.translation) {
				line.createDiv({ cls: "nihong-ai-log-cache-val", text: e.translation });
			}
			// 点击整行重播该 blob URL
			line.addEventListener("click", () => {
				playTTSCacheBlob(e.blobUrl);
			});
		}
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

/** TTS 引擎内部 id → 展示标签 */
function engineLabel(engine: string): string {
	switch (engine) {
		case "google":
			return "Google";
		case "windows":
			return "Windows";
		default:
			return engine;
	}
}
