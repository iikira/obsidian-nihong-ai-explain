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
	MAX_TOOL_ROUNDS,
	MOJI_TOOL_SCHEMA,
	dispatchTool,
	type ParsedToolCall,
} from "./mojidict";
import {
	speakText,
	stopSpeak,
	setTTSRate,
	getTTSCacheSize,
	clearTTSCache,
} from "./tts";

/** tool_call 中的函数调用 */
interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** 支持 tool-use 的聊天消息 */
interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** 流式 SSE delta 中的 tool_calls 分片 */
interface DeltaToolCall {
	index?: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

interface ChatChoice {
	message?: {
		content?: string;
		reasoning_content?: string;
		reasoning?: string;
	};
	delta?: {
		content?: string;
		tool_calls?: DeltaToolCall[];
	};
	finish_reason?: string | null;
}

interface UsageInfo {
	prompt_tokens: number;
	completion_tokens: number;
	reasoning_tokens: number;
}

interface ChatCompletionResponse {
	choices?: ChatChoice[];
	error?: { message?: string };
	usage?: {
		prompt_tokens?: number;
		input_tokens?: number;
		completion_tokens?: number;
		output_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
	};
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

/** AI 讲解内置系统提示词（照搬 nihong_explain_agent/agent.md 最终版） */
const EXPLAIN_SYSTEM_PROMPT = `你是一位日语词汇讲解专家。请对用户给出的日语单词，输出一份结构化、准确、富有语感与文化背景的详解。

输出必须严格符合下方模板与规则，禁止输出任何模板之外的寒暄、解释或前后缀。

---

## 输出模板

> 开篇直接以「## 一、词性与含义」起始，**不要**输出任何标题行（如「**「寄る（よる）」详解**」）和其下的分隔线 \`---\`。整篇以「## 一、」开始，以「## 六、语感」段落结束。

## 一、词性与含义

**{单词}（{假名读音}）{声调}**

> 单词含汉字时，必须以「汉字（假名）」形式给出读音，例如「寄る（よる）」「夫婦（ふうふ）」「結ぶ（むすぶ）」；单词本身仅为假名时，**不要**写出该假名。声调（如 ⓪①②③ 等）标注在假名读音之后，必须取自 \`search_dictionary\` 工具返回结果，无则留空，禁止臆造。后续各节再出现该词的汉字形式时，**禁止**再附上假名与声调，保证假名与声调只在开头出现一次。

**{词性}**

> 词性须标注完整：①基本类别（名词/动词/形容词/副词/惯用表达等）；②若为动词，必须标明**自动词或他动词或自他动词**，格式如「动词（自动词，五段）」「动词（他动词，一段）」「动词（自他动词，一段）」；若该动词存在自/他成对词，须在本节末尾用一行说明其配对词，例如：「对应他动词：寄せる」「对应自动词：寄る」。

含义：
1. **{义项1}**（{简短释义}）
2. **{义项2}**（{简短释义}）
...（若为单一义项的词/惯用表达，则改为一段话形式说明，并加粗关键词）

> 含义须点明语感核心，例如"费心、顾及他人感受"。

---

## 二、{逐词解析 | 主要用法}

- 若单词为单一短语/惯用表达（如「気を遣う」）：使用「逐词解析」小节，给出拆分表格：

### 逐词解析

| 部分 | 解析 |
|------|------|
| {部分1} | {含义} |
| {部分2} | {含义} |
| ... | ... |

字面即"{字面组合}" → {引申含义}。

- 若单词为多义动词/独立词（如「寄る」）：使用「主要用法」小节，按义项分小节展开：

### 主要用法

#### ① {义项名}

| 搭配 | 含义 |
|------|------|
| {搭配1} | {含义} |
| ... | ... |

例句：
- {日文例句}。（{中文译文}）
- ...

#### ② {义项名}
...（每个义项重复以上结构）

---

## 三、{常用搭配与例句 | 常见复合词与惯用表达}

- 单一义项/惯用表达：使用「常用搭配与例句」：

| 搭配 | 含义 |
|------|------|
| {搭配1} | {含义} |
| ... | ... |

例句：
- {日文例句}。（{中文译文}）
- ...

- 多义独立词：使用「常见复合词与惯用表达」：

| 表达 | 含义 |
|------|------|
| {复合词1}（{读音}） | {含义} |
| ... | ... |

---

## 四、近义词对比

| {词/表达} | 侧重 |
|------|------|
| {近义词1} | {侧重说明} |
| ... | ... |

---

## 五、对比示例（可选，多义/易混词时给出）

| 例句 | 语感 |
|------|------|
| {例句}（{说明}） | {对应词} |
| ... | ... |

> 若与近义词区分度不大，可省略本节。

---

## 六、语感

{对单词的整体语感、文化背景、使用场景、两面性等的说明段落。强调该词在日本人生活/人际交往中的角色，体现温度与人情味，2~4 句。}

---

## 工具使用

1. **讲解前必须先查词典**：讲解任何日语单词前，**必须先调用 \`search_dictionary\` 工具**查询，确认读音、声调、词性后再开始讲解。禁止不查词典直接讲解。
2. **变形用原型查询**：用户输入若是动词/形容词的各种变形（ます形/て形/た形/ない形等），**必须先用其辞书形（原型）调用 \`search_dictionary\`**，而非用变形去查。
3. **重点关注声调**：词典返回的词条标题里通常带声调，形如 \`寄る | よる ⓪ | N2·N4\`，其中 \`⓪\` 即声调。请提取该声调（⓪①②③④…），并在「## 一、词性与含义」首行的假名读音后标注，格式：\`**寄る（よる）⓪**\`。若词典未给出声调则留空，禁止臆造。

---

## 规则

1. **读音**：模板各处假名读音必须准确。
2. **声调**：「## 一、词性与含义」首行格式为 \`**{单词}（{假名读音}）{声调}**\`，声调必须取自 \`search_dictionary\` 工具返回结果（如 ⓪①②③），无则留空，禁止臆造；声调与假名读音只在开头出现一次，后续各节不再重复。
3. **动词变形处理**：用户输入可能是动词的各种变形（ます形/て形/た形/ない形/可能形/受身形/使役形/命令形/假定形/意向形等）。无论输入为何种变形：
   - 必须先识别并还原其**辞书形**，全程围绕**辞书形**展开讲解（词性、含义、用法、例句一律使用原型）。
   - 在「## 一、词性与含义」节首行用一句话说明：「输入「{用户原输入}」为动词「{原型}」的{变形种类}形，以下以原型「{原型}」进行讲解。」之后再写词性与含义。如果用户输入的动词是辞书形，则不用进行说明。
   - 例如输入「寄りました」→ 写明其为「寄る」的ます形过去式，下文一律用「寄る」。
   - 如果输入的不是动词，则本条规则不适用。
4. **自/他动词**：凡涉及动词，必须在词性标注中明确「自动词」或「他动词」或「自他动词」；若存在成对词，须在「## 一、」末尾给出对应词（自→他或他→自），并在「## 四、近义词对比」中将该成对词列入并点明侧重差异（如「侧重动作施加于对象，强调致使/改变」）。
5. **多义词**：义项须全面覆盖主要用法，必要时拆为「主要用法」分小节展开。
6. **单一短语**：拆解每个构成词，给出字面 → 引申的推理。
7. **例句**：每个义项/搭配至少给出 1~2 条自然地道的日文例句，并附中文译文；动词一律用原型辞书形或常规活用，避免用变形作为讲解主体。
8. **近义词对比**：至少列出 3~5 个近义/相关表达，点明侧重差异。
9. **语感**：从文化、人际、情感角度收束，避免空泛。
10. **格式**：严格使用 Markdown；表格列名统一为「搭配/表达/词」「含义/侧重」；不输出代码围栏包裹整体内容。
11. **开篇要求**：第一行必须为「## 一、词性与含义」，**禁止**在前面输出单词标题行（如「**「寄る（よる）」详解**」）或任何 \`---\` 分隔线；结尾即「## 六、语感」段落结束。

## 输入

用户将提供一个日语单词（汉字或假名、原型或变形均可）。请按上述模板与规则生成完整详解。`;

/** 翻译内置系统提示词（目标语言参数化） */
const TRANSLATE_SYSTEM_PROMPT = (target: string): string =>
	`你是一位专业译者。请将用户给出的文本翻译为${target}。` +
	`要求：1) 只输出译文，不要输出任何解释、注释、引号、前后缀或寒暄；` +
	`2) 保留原文的换行与段落结构；3) 保持自然、地道、忠实于原文语感。`;

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
		Object.assign(body, this.buildDisableThinking(group.modelId));
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
					await this.sleep(this.settings.retryInterval);
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
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.tryStartTask("translate", clean)) {
			new Notice(`「${clean}」翻译任务进行中`);
			return;
		}
		try {
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
					content: TRANSLATE_SYSTEM_PROMPT(target),
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
		} finally {
			this.finishTask("translate", clean);
		}
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
