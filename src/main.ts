import {
	Notice,
	Plugin,
	TFile,
	FileSystemAdapter,
	normalizePath,
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
import { DictionaryManager } from "./dictionary/manager";
import { DictionaryPopup } from "./dictionary/popup";
import { centerRect } from "./popupUtils";
import {
	MAX_TOOL_ROUNDS,
	MOJI_TOOL_SCHEMA,
	dispatchTool,
	type ParsedToolCall,
} from "./mojidict";
import { EXPLAIN_SYSTEM_PROMPT } from "./prompts";
import {
	buildDisableThinking,
	sleep,
	type ChatCompletionResponse,
	type ChatMessage,
	type UsageInfo,
} from "./shared";
import {
	speakText,
	stopSpeak,
	setTTSRate,
	getTTSCacheSize,
	clearTTSCache,
} from "./tts";

const MAX_WORD_LEN = 100;
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;


export default class NihongAIExplainPlugin extends Plugin {
	settings!: NihongAIExplainSettings;
	private pill: SelectionPill | null = null;
	private translateService: TranslateService | null = null;
	dictionaryManager: DictionaryManager | null = null;
	private dictionaryPopup: DictionaryPopup | null = null;

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
			getSelectionRect: () => this.getSelectionRect(),
		});
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
		this.dictionaryPopup?.hide();
		this.dictionaryPopup = null;
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


	/** 解析 SSE 流式响应，聚合 content / tool_calls / usage / finish_reason */
	private async parseStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<{
		content: string;
		toolCalls: ParsedToolCall[];
		usage: UsageInfo;
		finishReason: string | null;
	}> {
		const decoder = new TextDecoder();
		const contentParts: string[] = [];
		const toolCallsMap = new Map<
			number,
			{ id: string; name: string; arguments: string }
		>();
		let usage: UsageInfo = {
			prompt_tokens: 0,
			completion_tokens: 0,
			reasoning_tokens: 0,
		};
		let finishReason: string | null = null;
		let buf = "";

		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split("\n");
			// 保留最后未完整的一行
			buf = lines.pop() ?? "";
			for (let line of lines) {
				line = line.trim();
				if (!line.startsWith("data:")) {
					continue;
				}
				const chunk = line.slice(5).trim();
				if (chunk === "[DONE]") {
					break;
				}
				let obj: ChatCompletionResponse;
				try {
					obj = JSON.parse(chunk) as ChatCompletionResponse;
				} catch {
					continue;
				}
				if (obj.usage) {
					const u = obj.usage;
					usage = {
						prompt_tokens:
							u.prompt_tokens ?? u.input_tokens ?? 0,
						completion_tokens:
							u.completion_tokens ?? u.output_tokens ?? 0,
						reasoning_tokens:
							u.completion_tokens_details?.reasoning_tokens ??
							0,
					};
				}
				const choices = obj.choices ?? [];
				if (choices.length === 0) {
					continue;
				}
				const ch = choices[0];
				if (ch.finish_reason) {
					finishReason = ch.finish_reason;
				}
				const delta = ch.delta;
				if (!delta) {
					continue;
				}
				if (delta.content) {
					contentParts.push(delta.content);
				}
				for (const tc of delta.tool_calls ?? []) {
					const idx = tc.index ?? 0;
					const entry =
						toolCallsMap.get(idx) ??
						{ id: "", name: "", arguments: "" };
					if (tc.id) {
						entry.id = tc.id;
					}
					if (tc.function?.name) {
						entry.name = tc.function.name;
					}
					if (tc.function?.arguments) {
						entry.arguments += tc.function.arguments;
					}
					toolCallsMap.set(idx, entry);
				}
			}
		}

		const toolCalls: ParsedToolCall[] = [];
		for (const idx of [...toolCallsMap.keys()].sort((a, b) => a - b)) {
			const entry = toolCallsMap.get(idx)!;
			let args: Record<string, unknown> = {};
			if (entry.arguments) {
				try {
					args = JSON.parse(entry.arguments) as Record<
						string,
						unknown
					>;
				} catch {
					args = {};
				}
			}
			toolCalls.push({
				id: entry.id || `call_${idx}`,
				name: entry.name,
				arguments: args,
				argumentsRaw: entry.arguments,
			});
		}

		return {
			content: contentParts.join(""),
			toolCalls,
			usage,
			finishReason,
		};
	}

	/** 发起一轮流式请求（带重试），返回解析后的 content/tool_calls/usage/finish */
	private async callStreamRound(
		messages: ChatMessage[],
		group: ModelGroup,
		withTools: boolean,
	): Promise<{
		content: string;
		toolCalls: ParsedToolCall[];
		usage: UsageInfo;
		finishReason: string | null;
	}> {
		const url = `${group.apiUrl.replace(/\/$/, "")}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		};
		if (group.apiKey) {
			headers["Authorization"] = `Bearer ${group.apiKey}`;
		}
		const body: Record<string, unknown> = {
			model: group.modelId,
			messages,
			temperature: this.settings.temperature,
			stream: true,
		};
		Object.assign(body, buildDisableThinking(group.modelId));
		if (withTools) {
			body["tools"] = MOJI_TOOL_SCHEMA;
			body["tool_choice"] = "auto";
		}

		const max = Math.max(0, this.settings.maxRetries);
		let lastErr: unknown = null;
		for (let attempt = 1; attempt <= max; attempt++) {
			try {
				const resp = await fetch(url, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
				if (!resp.ok || !resp.body) {
					const errText = await resp.text().catch(() => "");
					throw new Error(
						`流式请求失败: HTTP ${resp.status} ${errText.slice(0, 200)}`,
					);
				}
				const reader = resp.body.getReader();
				try {
					return await this.parseStream(reader);
				} finally {
					reader.releaseLock();
				}
			} catch (e) {
				lastErr = e;
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(
					`[nihong-ai-explain] 第 ${attempt}/${max} 次流式失败: ${msg}`,
				);
				if (attempt < max) {
					await sleep(this.settings.retryInterval);
				}
			}
		}
		const finalMsg =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new Error(`流式重试 ${max} 次后仍失败: ${finalMsg}`);
	}

	/** 打印单轮 token 用量诊断 */
	private logTokenUsage(round: number, usage: UsageInfo): void {
		console.log(
			`[nihong-ai-explain] 第 ${round} 轮 token: ` +
				`输入=${usage.prompt_tokens} ` +
				`输出=${usage.completion_tokens} ` +
				`思考=${usage.reasoning_tokens} ` +
				`合计=${usage.prompt_tokens + usage.completion_tokens}`,
		);
	}

	/** 打印整个讲解流程累加 token 用量 */
	private logTokenTotal(total: UsageInfo): void {
		console.log(
			`[nihong-ai-explain] token 合计: ` +
				`输入=${total.prompt_tokens} ` +
				`输出=${total.completion_tokens} ` +
				`思考=${total.reasoning_tokens} ` +
				`合计=${total.prompt_tokens + total.completion_tokens}`,
		);
	}

	/**
	 * AI 讲解 tool-use 循环：引导模型先调 search_dictionary 查词典（须用原型），
	 * 代码本地执行查词典并把结果回灌给模型，模型拿到结果后生成最终讲解。
	 */
	private async runExplainToolLoop(
		messages: ChatMessage[],
		group: ModelGroup,
		deviceId: string,
		token: string,
	): Promise<string> {
		const total: UsageInfo = {
			prompt_tokens: 0,
			completion_tokens: 0,
			reasoning_tokens: 0,
		};

		for (let rnd = 1; rnd <= MAX_TOOL_ROUNDS; rnd++) {
			const { content, toolCalls, usage, finishReason } =
				await this.callStreamRound(messages, group, true);
			total.prompt_tokens += usage.prompt_tokens;
			total.completion_tokens += usage.completion_tokens;
			total.reasoning_tokens += usage.reasoning_tokens;
			this.logTokenUsage(rnd, usage);

			// 无工具调用：模型给出最终讲解
			if (toolCalls.length === 0) {
				console.log(
					`[nihong-ai-explain] 第 ${rnd} 轮返回最终讲解（finish=${finishReason}）`,
				);
				this.logTokenTotal(total);
				return content;
			}

			// 有工具调用：追加 assistant 消息（带 tool_calls）+ 回灌 tool 结果
			messages.push({
				role: "assistant",
				content: content || null,
				tool_calls: toolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: {
						name: tc.name,
						arguments: tc.argumentsRaw,
					},
				})),
			});

			for (const tc of toolCalls) {
				console.log(
					`[nihong-ai-explain] 第 ${rnd} 轮调用工具 ${tc.name}(${JSON.stringify(tc.arguments)})`,
				);
				const resultStr = await dispatchTool(
					tc.name,
					tc.arguments,
					deviceId,
					token,
				);
				console.log(
					`[nihong-ai-explain] 工具 ${tc.name} 返回结果:`,
					resultStr,
				);
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					content: resultStr,
				});
			}
		}

		// 超过最大轮数：去掉 tools 兜底强制生成
		console.log(
			`[nihong-ai-explain] 达到最大轮数 ${MAX_TOOL_ROUNDS}，兜底强制生成`,
		);
		const { content, usage } = await this.callStreamRound(
			messages,
			group,
			false,
		);
		total.prompt_tokens += usage.prompt_tokens;
		total.completion_tokens += usage.completion_tokens;
		total.reasoning_tokens += usage.reasoning_tokens;
		this.logTokenUsage(MAX_TOOL_ROUNDS + 1, usage);
		this.logTokenTotal(total);
		return content;
	}

	async explain(word: string): Promise<void> {
		const clean = word.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.tryStartTask("explain", clean)) {
			new Notice(`「${clean}」AI 讲解任务进行中`);
			return;
		}
		try {
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
			const group = this.getExplainModelGroup();
			const deviceId = this.settings.mojiDeviceId ?? "";
			const token = this.settings.mojiToken ?? "";

			const messages: ChatMessage[] = [
				{ role: "system", content: EXPLAIN_SYSTEM_PROMPT },
				{ role: "user", content: `请讲解以下日语单词：${clean}` },
			];

			let content = "";
			try {
				content = await this.runExplainToolLoop(
					messages,
					group,
					deviceId,
					token,
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
		} finally {
			this.finishTask("explain", clean);
		}
	}

	async translate(text: string): Promise<void> {
		if (!this.translateService) {
			return;
		}
		return this.translateService.translate(text);
	}

	async lookup(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.tryStartTask("lookup", clean)) {
			new Notice(`「${clean}」词典查询任务进行中`);
			return;
		}
		try {
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
		} finally {
			this.finishTask("lookup", clean);
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
