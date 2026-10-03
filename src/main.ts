import {
	Notice,
	Plugin,
	FileSystemAdapter,
	TFile,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	type ModelGroup,
	NihongAIExplainSettings,
	NihongAIExplainSettingTab,
} from "./settings";
import { SelectionPill, type PillAction } from "./pill";
import { TranslateService } from "./translate/service";
import { LRUTranslateCache } from "./translate/cache";
import { ExplainService } from "./explain/service";
import { LookupService } from "./dictionary/lookupService";
import { ConverterService } from "./converter/service";
import { EPUB_VIEW_TYPE, EpubView } from "./converter/view";
import { DictionaryManager } from "./dictionary/manager";
import { getSelectionRect } from "./utils";
import {
	speakText,
	stopSpeak,
	setTTSRate,
	getTTSCacheSize,
	clearTTSCache,
} from "./tts";



export default class NihongAIExplainPlugin extends Plugin {
	settings!: NihongAIExplainSettings;
	private pill: SelectionPill | null = null;
	private translateService: TranslateService | null = null;
	private explainService: ExplainService | null = null;
	private lookupService: LookupService | null = null;
	private converterService: ConverterService | null = null;
	dictionaryManager: DictionaryManager | null = null;

	/** 暴露翻译缓存供设置页读取（显示条数 / 清空） */
	get translateCache(): LRUTranslateCache | null {
		return this.translateService?.cache ?? null;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		setTTSRate(this.settings.ttsRate);
		this.addSettingTab(new NihongAIExplainSettingTab(this.app, this));

		this.translateService = new TranslateService({
			settings: () => this.settings,
			getModelGroup: () => this.getTranslateModelGroup(),
			tryStartTask: (a, t) => this.tryStartTask(a, t),
			finishTask: (a, t) => this.finishTask(a, t),
			getSelectionRect: () => getSelectionRect(),
		});
		this.dictionaryManager = new DictionaryManager();
		this.dictionaryManager.setApp(this.app);
		if (this.manifest.dir) {
			this.dictionaryManager.setPluginDir(this.manifest.dir);
		}
		await this.dictionaryManager.init();
		this.explainService = new ExplainService({
			settings: () => this.settings,
			getModelGroup: () => this.getExplainModelGroup(),
			tryStartTask: (a, t) => this.tryStartTask(a, t),
			finishTask: (a, t) => this.finishTask(a, t),
			vault: () => this.app.vault,
		});
		this.lookupService = new LookupService({
			getManager: () => this.dictionaryManager,
			getDictFontSize: () => this.settings.dictFontSize,
			tryStartTask: (a, t) => this.tryStartTask(a, t),
			finishTask: (a, t) => this.finishTask(a, t),
			getSelectionRect: () => getSelectionRect(),
		});
		this.converterService = new ConverterService({
			getVault: () => this.app.vault,
			tryStartTask: (a, k) => this.tryStartTask(a, k),
			finishTask: (a, k) => this.finishTask(a, k),
		});
		this.registerView(
			EPUB_VIEW_TYPE,
			(leaf) =>
				new EpubView(leaf, {
					onConvert: (file) => void this.converterService?.convert(file),
				}),
		);
		this.registerExtensions(["epub"], EPUB_VIEW_TYPE);
		this.pill = new SelectionPill(this.buildPillActions());
		this.pill.attach();
		this.applyLexisPillDisabled();

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const sel = editor.getSelection().trim();
				if (!sel) {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle("AI 讲解此词")
						.setIcon("sparkles")
						.onClick(() => void this.explain(sel));
				});
				menu.addItem((item) => {
					item
						.setTitle("翻译此段")
						.setIcon("languages")
						.onClick(() => void this.translate(sel));
				});
				menu.addItem((item) => {
					item
						.setTitle("查词典")
					.setIcon("book-open")
					.onClick(() => void this.lookup(sel));
			});
			menu.addItem((item) => {
				item
					.setTitle("朗读")
					.setIcon("volume-2")
					.onClick(() => void this.speakText(sel));
			});
		})
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) {
					return;
				}
				if (file.extension.toLowerCase() !== "epub") {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle("转换为 md")
						.setIcon("document")
						.onClick(() => void this.converterService?.convert(file));
				});
			})
		);

		this.addCommand({
			id: "nihong-ai-explain-selection",
			name: "AI 讲解选中文字",
			callback: () => {
				const sel = window.getSelection()?.toString().trim() ?? "";
				if (!sel) {
					new Notice("请先选中一段文字");
					return;
				}
				void this.explain(sel);
			},
		});

		this.addCommand({
			id: "nihong-ai-translate-selection",
			name: "翻译选中文字",
			callback: () => {
				const sel = window.getSelection()?.toString().trim() ?? "";
				if (!sel) {
					new Notice("请先选中一段文字");
					return;
				}
				void this.translate(sel);
			},
		});

		this.addCommand({
			id: "nihong-ai-lookup-selection",
			name: "查词典选中文字",
			callback: () => {
				const sel = window.getSelection()?.toString().trim() ?? "";
				if (!sel) {
					new Notice("请先选中一段文字");
					return;
				}
				void this.lookup(sel);
			},
		});
	}

	onunload(): void {
		this.pill?.detach();
		this.pill = null;
		this.translateService?.onUnload();
		this.translateService = null;
		this.lookupService?.onUnload();
		this.lookupService = null;
		this.converterService = null;
		this.dictionaryManager = null;
		stopSpeak();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		) as NihongAIExplainSettings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}


	/** 按 id 查找大模型分组；找不到或配置不全则抛错 */
	private getModelGroup(id: string, label: string): ModelGroup {
		const groups = this.settings.modelGroups ?? [];
		const g = groups.find((x) => x.id === id);
		if (!g) {
			throw new Error(`未配置${label}的大模型分组，请在设置中选择`);
		}
		if (!g.apiUrl || !g.modelId) {
			throw new Error(
				`${label}分组「${g.name || g.id}」未配置 API 地址或模型 id`,
			);
		}
		return g;
	}

	/** AI 讲解用的大模型分组 */
	private getExplainModelGroup(): ModelGroup {
		return this.getModelGroup(this.settings.explainModelGroupId, "AI 讲解");
	}

	/** 翻译用的大模型分组 */
	private getTranslateModelGroup(): ModelGroup {
		return this.getModelGroup(this.settings.translateModelGroupId, "翻译");
	}

	/** 朗读选区文本 */
	speakText(text: string): void {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.tryStartTask("tts", clean)) {
			new Notice(`「${clean}」正在朗读中`);
			return;
		}
		void speakText(clean).finally(() => this.finishTask("tts", clean));
	}

	/** 停止朗读 */
	stopSpeak(): void {
		stopSpeak();
	}

	/** TTS 缓存条数 */
	ttsCacheSize(): number {
		return getTTSCacheSize();
	}

	/** 清空 TTS 缓存 */
	clearTTSCache(): void {
		clearTTSCache();
	}

	/** 应用「禁用 Lexis 悬浮窗」开关到当前 pill */
	applyLexisPillDisabled(): void {
		this.pill?.setDisabledLexis(this.settings.disableLexisPill);
	}

	/** 进行中任务集合：key = `${actionId}::${text}`，防止同 action+同 text 重复触发 */
	private inFlightTasks = new Set<string>();

	/** 构造任务键 */
	private taskKey(actionId: string, text: string): string {
		return `${actionId}::${text.trim()}`;
	}

	/** 尝试占用任务槽；同 actionId+同 text 已在跑时返回 false */
	tryStartTask(actionId: string, text: string): boolean {
		const key = this.taskKey(actionId, text);
		if (this.inFlightTasks.has(key)) {
			return false;
		}
		this.inFlightTasks.add(key);
		return true;
	}

	/** 释放任务槽（任务结束调用） */
	finishTask(actionId: string, text: string): void {
		this.inFlightTasks.delete(this.taskKey(actionId, text));
	}

	/** 构造 pill actions（默认包含「朗读」按钮） */
	private buildPillActions(): PillAction[] {
		return [
			{
				id: "explain",
				label: "AI 讲解",
				icon: "sparkles",
				handler: (text) => this.explain(text),
			},
			{
				id: "translate",
				label: "翻译",
				icon: "languages",
				handler: (text) => this.translate(text),
			},
			{
				id: "lookup",
				label: "查词典",
				icon: "book-open",
				handler: (text) => this.lookup(text),
			},
			{
				id: "tts",
				label: "朗读",
				icon: "volume-2",
				handler: (text) => this.speakText(text),
			},
		];
	}


	async explain(word: string): Promise<void> {
		if (!this.explainService) {
			return;
		}
		return this.explainService.explain(word);
	}

	async translate(text: string): Promise<void> {
		if (!this.translateService) {
			return;
		}
		return this.translateService.translate(text);
	}

	async lookup(text: string): Promise<void> {
		if (!this.lookupService) {
			return;
		}
		return this.lookupService.lookup(text);
	}

	/** 获取插件目录的绝对路径（vault 根 + manifest.dir），仅桌面端可用 */
	getPluginDir(): string | null {
		const rel = this.manifest.dir;
		if (!rel) {
			return null;
		}
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			return null;
		}
		// 动态 require 避开 esbuild 静态分析，移动端 Capacitor 无 require 全局
		try {
			const dynamicRequire = new Function(
				"return typeof require !== 'undefined' ? require : undefined",
			)() as ((m: string) => unknown) | undefined;
			if (!dynamicRequire) {
				return null;
			}
			const pathMod = dynamicRequire("node:path") as {
				join: (...args: string[]) => string;
			};
			return pathMod.join(adapter.getBasePath(), rel);
		} catch {
			return null;
		}
	}

	/** 获取插件目录的 vault 相对路径，移动端可用（用于显示给用户复制） */
	getPluginDirRelative(): string | null {
		return this.manifest.dir ?? null;
	}
}
