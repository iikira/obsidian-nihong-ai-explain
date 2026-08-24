import {
	Notice,
	Plugin,
	TFile,
	FileSystemAdapter,
	normalizePath,
	requestUrl,
} from "obsidian";
import {
	DEFAULT_SETTINGS,
	type ModelGroup,
	NihongAIExplainSettings,
	NihongAIExplainSettingTab,
} from "./settings";
import { SelectionPill, type PillAction } from "./pill";
import { TranslateCard } from "./translateCard";
import { LRUTranslateCache } from "./translateCache";
import { DictionaryManager } from "./dictionary/manager";
import { DictionaryPopup } from "./dictionary/popup";
import { centerRect } from "./popupUtils";
import {
	speakText,
	stopSpeak,
	setTTSRate,
	getTTSCacheSize,
	clearTTSCache,
} from "./tts";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatChoice {
	message?: {
		content?: string;
		reasoning_content?: string;
		reasoning?: string;
	};
}

interface ChatCompletionResponse {
	choices?: ChatChoice[];
	error?: { message?: string };
}

interface PerfRecord {
	attempt: number;
	ok: boolean;
	status: number;
	ms: number;
	model: string;
	msgCount: number;
	contentLen?: number;
	error?: string;
}

const MAX_WORD_LEN = 100;
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;

export default class NihongAIExplainPlugin extends Plugin {
	settings!: NihongAIExplainSettings;
	private pill: SelectionPill | null = null;
	private translateCard: TranslateCard | null = null;
	translateCache: LRUTranslateCache | null = null;
	dictionaryManager: DictionaryManager | null = null;
	private dictionaryPopup: DictionaryPopup | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		setTTSRate(this.settings.ttsRate);
		this.addSettingTab(new NihongAIExplainSettingTab(this.app, this));

		this.translateCard = new TranslateCard();
		this.translateCache = new LRUTranslateCache();
		this.translateCache.load();
		this.dictionaryManager = new DictionaryManager();
		this.dictionaryManager.setApp(this.app);
		if (this.manifest.dir) {
			this.dictionaryManager.setPluginDir(this.manifest.dir);
		}
		await this.dictionaryManager.init();
		this.dictionaryPopup = new DictionaryPopup(
			(name) => this.dictionaryManager?.getTag(name),
			(query) => this.lookupInPopup(query),
			() => this.settings.dictFontSize,
		);
		this.pill = new SelectionPill(this.buildPillActions());
		this.pill.attach();

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
		this.translateCard?.hide();
		this.translateCard = null;
		this.dictionaryPopup?.hide();
		this.dictionaryPopup = null;
		this.translateCache?.flush();
		this.translateCache = null;
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

	private sanitizeFileName(word: string): string {
		return word
			.replace(FORBIDDEN_NAME_CHARS, "")
			.replace(/\s+/g, "_")
			.trim()
			.slice(0, MAX_WORD_LEN) || "untitled";
	}

	private resolveTargetPath(word: string): string {
		const fileName = `${this.sanitizeFileName(word)}.md`;
		const dir = (this.settings.outputDir ?? "").trim();
		if (!dir) {
			return normalizePath(fileName);
		}
		return normalizePath(`${dir}/${fileName}`);
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) {
			return;
		}
		const normalized = normalizePath(folder);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing) {
			return;
		}
		try {
			await this.app.vault.createFolder(normalized);
		} catch (e) {
			// 可能是并发创建，忽略
			const again = this.app.vault.getAbstractFileByPath(normalized);
			if (!again) {
				throw e;
			}
		}
	}

	private buildMessages(word: string): ChatMessage[] {
		const user = this.settings.userPromptTemplate.replace(/\{\{word\}\}/g, word);
		return [
			{ role: "system", content: this.settings.systemPrompt },
			{ role: "user", content: user },
		];
	}

	/**
	 * 按模型 id 动态组装"关闭思考"字段，返回要合并进请求 body 的对象。
	 * - hy3-free：OpenAI 风格 { reasoning_effort: "none" }
	 * - 含 deepseek-v4：DeepSeek 风格 { thinking: { type: "disabled" } }
	 * - 其他：默认 OpenAI 风格 { reasoning_effort: "none" }
	 */
	private buildDisableThinking(model: string): Record<string, unknown> {
		if (model.includes("deepseek-v4")) {
			return { thinking: { type: "disabled" } };
		}
		return { reasoning_effort: "none" };
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
		void speakText(text);
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

	private async callModelOnce(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature?: number,
		attempt = 1,
	): Promise<string> {
		const url = `${group.apiUrl.replace(/\/$/, "")}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (group.apiKey) {
			headers["Authorization"] = `Bearer ${group.apiKey}`;
		}
		const body: Record<string, unknown> = {
			model: group.modelId,
			messages,
			temperature: temperature ?? this.settings.temperature,
			stream: false,
		};
		Object.assign(body, this.buildDisableThinking(group.modelId));
		const t0 = performance.now();
		let status = 0;
		try {
			const resp = await requestUrl({
				url,
				method: "POST",
				headers,
				body: JSON.stringify(body),
				throw: false,
			});
			status = resp.status;
			const t1 = performance.now();
			const ms = Math.round((t1 - t0) * 100) / 100;
			const data = resp.json as ChatCompletionResponse;
			if (resp.status < 200 || resp.status >= 300) {
				const errMsg =
					data?.error?.message ||
					`HTTP ${resp.status}`;
				this.logPerf({
					attempt,
					ok: false,
					status,
					ms,
					model: group.modelId,
					msgCount: messages.length,
					error: `HTTP ${resp.status}`,
				});
				throw new Error(`API 请求失败: ${errMsg}`);
			}
			if (!data || !data.choices || data.choices.length === 0) {
				this.logPerf({
					attempt,
					ok: false,
					status,
					ms,
					model: group.modelId,
					msgCount: messages.length,
					error: "no choices",
				});
				throw new Error("响应无 choices");
			}
			const msg = data.choices[0].message;
			const content = msg?.content ?? "";
			const reasoning = msg?.reasoning_content || msg?.reasoning || "";
			if (reasoning.trim()) {
				console.warn(
					`[nihong-ai-explain] reasoning_content 非空 (${reasoning.length} chars)，仍按 content 输出`
				);
			}
			if (!content.trim()) {
				this.logPerf({
					attempt,
					ok: false,
					status,
					ms,
					model: group.modelId,
					msgCount: messages.length,
					error: "empty content",
				});
				throw new Error("响应 message.content 为空");
			}
			this.logPerf({
				attempt,
				ok: true,
				status,
				ms,
				model: group.modelId,
				msgCount: messages.length,
				contentLen: content.length,
			});
			return content;
		} catch (e) {
			const ms = Math.round((performance.now() - t0) * 100) / 100;
			const err = e instanceof Error ? e.message : String(e);
			// 仅当 status 仍为 0（异常在 await 前/中抛出且未走到上面记录分支）时补记一次
			if (status === 0) {
				this.logPerf({
					attempt,
					ok: false,
					status: 0,
					ms,
					model: group.modelId,
					msgCount: messages.length,
					error: err,
				});
			}
			throw e;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	private perfRecords: PerfRecord[] = [];

	private logPerf(rec: PerfRecord): void {
		this.perfRecords.push(rec);
	}

	private flushPerfTable(): void {
		const records = this.perfRecords;
		this.perfRecords = [];
		if (records.length === 0) {
			return;
		}
		const okCount = records.filter((r) => r.ok).length;
		const totalMs = records.reduce((s, r) => s + r.ms, 0);
		const last = records[records.length - 1];
		console.groupCollapsed(
			`[nihong-ai-explain perf] ${records.length} 次调用 · 成功 ${okCount} · 失败 ${records.length - okCount} · 累计 ${totalMs.toFixed(0)}ms · 终态 ${last.ok ? "成功" : "失败"}`,
		);
		console.table(records);
		console.log(
			`汇总: 尝试 ${records.length} 次, 总耗时 ${totalMs.toFixed(0)}ms, 平均 ${(totalMs / records.length).toFixed(0)}ms, 模型 ${last.model}, 消息数 ${last.msgCount}`,
		);
		console.groupEnd();
	}

	private async callModelWithRetry(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature?: number,
	): Promise<string> {
		const max = Math.max(0, this.settings.maxRetries);
		let lastErr: unknown = null;
		for (let attempt = 1; attempt <= max; attempt++) {
			try {
				const result = await this.callModelOnce(
					messages,
					group,
					temperature,
					attempt,
				);
				this.flushPerfTable();
				return result;
			} catch (e) {
				lastErr = e;
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(
					`[nihong-ai-explain] 第 ${attempt}/${max} 次失败: ${msg}`
				);
				if (attempt < max) {
					await this.sleep(this.settings.retryInterval);
				}
			}
		}
		this.flushPerfTable();
		const finalMsg =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new Error(`重试 ${max} 次后仍失败: ${finalMsg}`);
	}

	async explain(word: string): Promise<void> {
		const clean = word.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (clean.length > MAX_WORD_LEN) {
			new Notice(`选区过长（${clean.length} 字符），已截断使用前 ${MAX_WORD_LEN} 字符`);
		}

		const targetPath = this.resolveTargetPath(clean);
		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			new Notice(`已存在，跳过: ${targetPath}`);
			return;
		}

		new Notice("正在生成…");
		const messages = this.buildMessages(clean);
		let content: string;
		try {
			content = await this.callModelWithRetry(
				messages,
				this.getExplainModelGroup(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`生成失败: ${msg}`, 8000);
			console.error("[nihong-ai-explain] 生成失败:", e);
			return;
		}

		const dir = (this.settings.outputDir ?? "").trim();
		try {
			if (dir) {
				await this.ensureFolder(dir);
			}
			await this.app.vault.create(targetPath, content);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`写入文件失败: ${msg}`, 8000);
			console.error("[nihong-ai-explain] 写入失败:", e);
			return;
		}

		new Notice(`已生成: ${targetPath}`);
	}

	async translate(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.translateCard) {
			this.translateCard = new TranslateCard();
		}
		if (!this.translateCache) {
			this.translateCache = new LRUTranslateCache();
			this.translateCache.load();
		}

		const target = this.settings.targetLanguage || "中文";
		const cacheKey = JSON.stringify({ text: clean, target });
		const rect = this.getSelectionRect() ?? this.fallbackRect();

		// 缓存命中：静默显示，无任何提示
		const cached = this.translateCache.get(cacheKey);
		if (cached != null) {
			this.translateCard.showResult(cached, rect);
			return;
		}

		this.translateCard.showLoading(rect);

		const messages: ChatMessage[] = [
			{
				role: "system",
				content:
					`你是一位专业译者。请将用户给出的文本翻译为${target}。` +
					`要求：1) 只输出译文，不要输出任何解释、注释、引号、前后缀或寒暄；` +
					`2) 保留原文的换行与段落结构；3) 保持自然、地道、忠实于原文语感。`,
			},
			{ role: "user", content: clean },
		];

		try {
			const result = await this.callModelWithRetry(
				messages,
				this.getTranslateModelGroup(),
				0.3,
			);
			this.translateCache.set(cacheKey, result);
			const rectNow = this.getSelectionRect() ?? rect;
			this.translateCard.showResult(result, rectNow);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const rectNow = this.getSelectionRect() ?? rect;
			this.translateCard.showError(`翻译失败: ${msg}`, rectNow);
			console.error("[nihong-ai-explain] 翻译失败:", e);
		}
	}

	async lookup(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.dictionaryManager || !this.dictionaryManager.isReady) {
			new Notice("词典未初始化，请先在设置中导入词典");
			return;
		}
		const imported = await this.dictionaryManager.isImported();
		if (!imported) {
			new Notice("未导入词典，请先在设置中导入");
			return;
		}
		if (!this.dictionaryPopup) {
			this.dictionaryPopup = new DictionaryPopup(
				(name) => this.dictionaryManager?.getTag(name),
				(query) => this.lookupInPopup(query),
				() => this.settings.dictFontSize,
			);
		}

		const rect = this.getSelectionRect() ?? centerRect();
		this.dictionaryPopup.showLoading(rect);

		try {
			const results = await this.dictionaryManager.lookup(clean);
			const rectNow = this.getSelectionRect() ?? rect;
			this.dictionaryPopup.showResult(results, rectNow);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const rectNow = this.getSelectionRect() ?? rect;
			this.dictionaryPopup.showError(`查询失败: ${msg}`, rectNow);
			console.error("[nihong-ai-explain] 词典查询失败:", e);
		}
	}

	/** 卡片内交叉引用点击触发的重新查询，复用卡片当前位置而非选区 */
	private async lookupInPopup(query: string): Promise<void> {
		const clean = query.trim();
		if (!clean || !this.dictionaryManager || !this.dictionaryPopup) {
			return;
		}
		const rect = this.dictionaryPopup.getRect() ?? centerRect();
		this.dictionaryPopup.showLoading(rect);
		try {
			const results = await this.dictionaryManager.lookup(clean);
			this.dictionaryPopup.showResult(results, rect);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.dictionaryPopup.showError(`查询失败: ${msg}`, rect);
			console.error("[nihong-ai-explain] 词典交叉引用查询失败:", e);
		}
	}

	private getSelectionRect(): DOMRect | null {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return null;
		}
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			return null;
		}
		return rect;
	}

	private fallbackRect(): DOMRect {
		return centerRect();
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
