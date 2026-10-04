import { Notice, TFile, type Vault } from "obsidian";
import { EXPLAIN_SYSTEM_PROMPT } from "../prompts";
import { ensureFolder, MAX_WORD_LEN, resolveTargetPath } from "../utils";
import {
	buildDisableThinking,
	sleep,
	type ChatCompletionResponse,
	type ChatMessage,
	type UsageInfo,
} from "../shared";
import type { ModelGroup } from "../settings";
import type { LookupResult } from "../dictionary/types";

/** 讲解用到的设置项子集 */
interface ExplainConfig {
	temperature: number;
	maxRetries: number;
	retryInterval: number;
	outputDir: string;
}

export interface ExplainServiceOptions {
	/** 读取讲解相关设置 */
	settings: () => ExplainConfig;
	/** 获取讲解用的大模型分组 */
	getModelGroup: () => ModelGroup;
	/** 占用/释放任务槽（沿用插件全局防重入） */
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	/** 当前 vault */
	vault: () => Vault;
	/** 查离线词典（未加载/未导入时返回空数组） */
	lookup: (text: string) => Promise<LookupResult[]>;
	/** 离线词典是否已导入可用 */
	isDictionaryReady: () => boolean;
	/** 查声调（无数据返回空数组） */
	getAccents: (expression: string, reading: string) => number[];
}

/** 讲解服务：封装流式调用、词典参考注入与落盘编排。 */
export class ExplainService {
	private readonly opts: ExplainServiceOptions;

	constructor(opts: ExplainServiceOptions) {
		this.opts = opts;
	}

	/** 解析 SSE 流式响应，聚合 content / usage / finish_reason */
	private async parseStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<{
		content: string;
		usage: UsageInfo;
		finishReason: string | null;
	}> {
		const decoder = new TextDecoder();
		const contentParts: string[] = [];
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
						prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
						completion_tokens:
							u.completion_tokens ?? u.output_tokens ?? 0,
						reasoning_tokens:
							u.completion_tokens_details?.reasoning_tokens ?? 0,
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
			}
		}

		return {
			content: contentParts.join(""),
			usage,
			finishReason,
		};
	}

	/** 发起流式请求（带重试），返回解析后的 content/usage/finish */
	private async callStream(
		messages: ChatMessage[],
		group: ModelGroup,
	): Promise<{ content: string; usage: UsageInfo; finishReason: string | null }> {
		const { temperature, maxRetries, retryInterval } = this.opts.settings();
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
			temperature,
			stream: true,
		};
		Object.assign(body, buildDisableThinking(group.modelId));

		const max = Math.max(0, maxRetries);
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
					await sleep(retryInterval);
				}
			}
		}
		const finalMsg =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new Error(`流式重试 ${max} 次后仍失败: ${finalMsg}`);
	}

	/** 打印 token 用量诊断 */
	private logTokenUsage(usage: UsageInfo): void {
		console.log(
			`[nihong-ai-explain] token: ` +
				`输入=${usage.prompt_tokens} ` +
				`输出=${usage.completion_tokens} ` +
				`思考=${usage.reasoning_tokens} ` +
				`合计=${usage.prompt_tokens + usage.completion_tokens}`,
		);
	}

	/**
	 * 查离线词典并把结果格式化成参考文本（含声调、词性标签、释义、例句）。
	 * 格式仿照词典弹窗的前端展示，按 expression|reading 分组，词头一行，
	 * 其下逐 sense-group 输出词性标签、义项序号与释义、例句。例如：
	 *   病む | やむ ①
	 *   5-dan; intransitive;
	 *   ① to fall ill
	 *     彼女は痛風を病んでいる。
	 *     She is affected with the gout.
	 *   5-dan; transitive;
	 *   ② to suffer from (e.g. a disease); to have something wrong with (e.g. an inner organ)
	 * 例句日文去振假名与空格；来源署名（JMdict | Tatoeba）丢弃。
	 * 词典未导入/未加载/查无结果时返回空字符串。
	 */
	private async buildDictionaryReference(word: string): Promise<string> {
		if (!this.opts.isDictionaryReady()) {
			return "";
		}
		let results: LookupResult[] = [];
		try {
			results = await this.opts.lookup(word);
		} catch (e) {
			console.warn("[nihong-ai-explain] 词典查询失败:", e);
			return "";
		}
		if (results.length === 0) {
			return "";
		}
		// 按 expression|reading 分组（与弹窗一致：同一词头下多个义项合并展示）
		const groups = new Map<string, LookupResult[]>();
		for (const r of results.slice(0, 8)) {
			const key = `${r.expression}|${r.reading}`;
			const arr = groups.get(key);
			if (arr) {
				arr.push(r);
			} else {
				groups.set(key, [r]);
			}
		}

		const lines: string[] = [];
		for (const [key, groupTerms] of groups) {
			const [expression, reading] = key.split("|");
			const accents = this.opts.getAccents(expression, reading);
			const accentStr = accents.length
				? " " + accents.map((p) => toAccentCircle(p)).join(",")
				: "";
			lines.push(`${expression} | ${reading}${accentStr}`);
			// 同一词头下多个 LookupResult（含不同变形来源）合并渲染。
			// 词性、义项序号、释义、例句都在 glossary 结构化内容里，交由 renderTermEntry 解析。
			for (const term of groupTerms) {
				for (const line of renderTermEntry(term.glossary)) {
					lines.push(line);
				}
			}
		}
		return lines.join("\n");
	}

	async explain(word: string): Promise<void> {
		const clean = word.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.opts.tryStartTask("explain", clean)) {
			new Notice(`「${clean}」AI 讲解任务进行中`);
			return;
		}
		try {
			const cfg = this.opts.settings();
			if (clean.length > MAX_WORD_LEN) {
				new Notice(
					`选区过长（${clean.length} 字符），已截断使用前 ${MAX_WORD_LEN} 字符`,
				);
			}

			const vault = this.opts.vault();
			const targetPath = resolveTargetPath(clean, cfg.outputDir);
			const existing = vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				new Notice(`已存在，跳过: ${targetPath}`);
				return;
			}

			new Notice("正在生成…");
			const group = this.opts.getModelGroup();

			// 查离线词典，命中则把结果作为参考拼进 user prompt
			const dictRef = await this.buildDictionaryReference(clean);
			let userContent: string;
			if (dictRef) {
				userContent =
					`请讲解以下日语单词：${clean}\n\n` +
					`该日语单词的词典查询结果如下，用于参考\n` +
					"```\n" + dictRef + "\n```\n";
			} else {
				userContent = `请讲解以下日语单词：${clean}`;
			}

			console.log("[nihong-ai-explain] 用户提示词:\n" + userContent);

			const messages: ChatMessage[] = [
				{ role: "system", content: EXPLAIN_SYSTEM_PROMPT },
				{ role: "user", content: userContent },
			];

			let content = "";
			try {
				const res = await this.callStream(messages, group);
				content = res.content;
				this.logTokenUsage(res.usage);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`生成失败: ${msg}`, 8000);
				console.error("[nihong-ai-explain] 生成失败:", e);
				return;
			}

			const dir = (cfg.outputDir ?? "").trim();
			try {
				if (dir) {
					await ensureFolder(vault, dir);
				}
				await vault.create(targetPath, content);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`写入文件失败: ${msg}`, 8000);
				console.error("[nihong-ai-explain] 写入失败:", e);
				return;
			}

			new Notice(`已生成: ${targetPath}`);
		} finally {
			this.opts.finishTask("explain", clean);
		}
	}
}

/** 把声调核位置数字转成圆圈数字标记（⓪①②…），与词典弹窗一致 */
function toAccentCircle(position: number): string {
	if (position === 0) {
		return "⓪";
	}
	if (position >= 1 && position <= 20) {
		return String.fromCodePoint(0x2460 + (position - 1));
	}
	return `(${position})`;
}

/**
 * 把一条 Yomitan 词条的 glossary（结构化内容）渲染成参考文本行（已含缩进）。
 * 针对 Jitendex 结构（也兼容标准 Yomitan 纯文本 glossary）：
 *   sense-groups（ul/li）→ 每个 sense-group 内的词性标签（part-of-speech-info /
 *   misc-info 的 span）单独一行；每个 sense（带 listStyleType 序号 ①②③ 或按序兜底）
 *   一行，后接该 sense 的 glossary li 释义（分号分隔）；example-sentence 块的日文
 *   （去 ruby 假名与空格）与译文各一行。
 * attribution / example-keyword 等来源/标记节点丢弃。
 */
function renderTermEntry(glossary: unknown): string[] {
	const lines: string[] = [];

	/** 取节点 data.content 标记 */
	const dataContent = (n: Record<string, unknown>): string => {
		const d = n.data as Record<string, unknown> | undefined;
		return d && typeof d.content === "string" ? d.content : "";
	};

	/** 取节点 style.listStyleType（形如 "①"）作为序号 */
	const listMarker = (n: Record<string, unknown>): string => {
		const s = n.style as Record<string, unknown> | undefined;
		const v = s && typeof s.listStyleType === "string" ? s.listStyleType : "";
		// 去掉包裹引号，如 "\"①\"" → "①"
		return v.replace(/^"|"$/g, "").trim();
	};

	/** 把节点子树里的纯文本拼起来（ruby 只留 base，去 rt；去多余空格） */
	const textOf = (node: unknown): string => {
		const parts: string[] = [];
		const walk = (n: unknown): void => {
			if (n == null) {
				return;
			}
			if (typeof n === "string") {
				parts.push(n);
				return;
			}
			if (Array.isArray(n)) {
				for (const c of n) {
					walk(c);
				}
				return;
			}
			if (typeof n !== "object") {
				return;
			}
			const o = n as Record<string, unknown>;
			// rt（振假名）整支丢弃
			if (o.tag === "rt") {
				return;
			}
			if (typeof o.text === "string") {
				parts.push(o.text);
				return;
			}
			if (o.content !== undefined) {
				walk(o.content);
				return;
			}
			if (Array.isArray(o.children)) {
				walk(o.children);
			}
		};
		walk(node);
		return parts.join("").replace(/\s+/g, " ").trim();
	};

	/** 收集某 sense 节点子树里的释义 li 与例句 */
	const renderSense = (senseNode: Record<string, unknown>): void => {
		const content = senseNode.content;
		const children = Array.isArray(content)
			? content
			: content != null
				? [content]
				: [];
		// 本 sense 的词性（misc-info 等 span）+ 释义 li
		const tags: string[] = [];
		const glosses: string[] = [];
		const examples: string[] = [];
		for (const child of children) {
			if (typeof child !== "object" || child == null) {
				continue;
			}
			const c = child as Record<string, unknown>;
			const dc = dataContent(c);
			if (dc === "glossary") {
				// glossary ul → 每个 li 是一条释义
				const lis = collectTag(c, "li");
				for (const li of lis) {
					const g = textOf(li);
					if (g) {
						glosses.push(g);
					}
				}
			} else if (dc === "example-sentence") {
				// 例句块：example-sentence-a 日文，example-sentence-b 译文
				const a = findDataContent(c, "example-sentence-a");
				const b = findDataContent(c, "example-sentence-b");
				const ja = a ? textOf(a) : "";
				const en = b ? textOf(b) : "";
				if (ja) {
					examples.push(ja);
				}
				if (en) {
					examples.push(en);
				}
			} else if (
				dc === "part-of-speech-info" ||
				dc === "misc-info"
			) {
				const t = textOf(c);
				if (t) {
					tags.push(t);
				}
			} else if (dc === "extra-info") {
				// extra-info 容器，递归找里面的 example-sentence
				walkForExamples(c, examples);
			}
		}
		// 词性标签（misc-info，如 colloquial）与释义拼在同一行，
		// 与用户期望的「① colloquial; 释义…」一致
		const marker = listMarker(senseNode);
		const head = marker ? `${marker} ` : "";
		const tagPrefix = tags.length > 0 ? `${tags.join("; ")}; ` : "";
		if (glosses.length > 0) {
			lines.push(`  ${head}${tagPrefix}${glosses.join("; ")}`);
		} else if (tags.length > 0) {
			lines.push(`  ${head}${tags.join("; ")};`);
		}
		for (const ex of examples) {
			lines.push(`    ${ex}`);
		}
	};

	/** 递归找 example-sentence 块，把日文/译文追加进 examples */
	const walkForExamples = (
		node: Record<string, unknown>,
		examples: string[],
	): void => {
		const content = node.content;
		const arr = Array.isArray(content)
			? content
			: content != null
				? [content]
				: [];
		for (const child of arr) {
			if (typeof child !== "object" || child == null) {
				continue;
			}
			const c = child as Record<string, unknown>;
			const dc = dataContent(c);
			if (dc === "example-sentence") {
				const a = findDataContent(c, "example-sentence-a");
				const b = findDataContent(c, "example-sentence-b");
				const ja = a ? textOf(a) : "";
				const en = b ? textOf(b) : "";
				if (ja) {
					examples.push(ja);
				}
				if (en) {
					examples.push(en);
				}
			} else {
				walkForExamples(c, examples);
			}
		}
	};

	/** 在 node 子树里找第一个 data.content === target 的节点 */
	const findDataContent = (
		node: Record<string, unknown>,
		target: string,
	): Record<string, unknown> | null => {
		const stack: Record<string, unknown>[] = [node];
		while (stack.length) {
			const n = stack.pop()!;
			if (dataContent(n) === target) {
				return n;
			}
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			for (const c of arr) {
				if (typeof c === "object" && c != null) {
					stack.push(c as Record<string, unknown>);
				}
			}
		}
		return null;
	};

	/** 在 node 子树里按文档顺序收集所有 tag === tagName 的节点 */
	const collectTag = (
		node: Record<string, unknown>,
		tagName: string,
	): Record<string, unknown>[] => {
		const out: Record<string, unknown>[] = [];
		// 深度优先、前序遍历，保持文档顺序
		const visit = (n: Record<string, unknown>): void => {
			if (n.tag === tagName) {
				out.push(n);
			}
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			for (const c of arr) {
				if (typeof c === "object" && c != null) {
					visit(c as Record<string, unknown>);
				}
			}
		};
		visit(node);
		return out;
	};

	/** 递归遍历，处理 sense-group 与 sense */
	const walk = (node: unknown): void => {
		if (node == null) {
			return;
		}
		if (Array.isArray(node)) {
			for (const c of node) {
				walk(c);
			}
			return;
		}
		if (typeof node !== "object") {
			return;
		}
		const n = node as Record<string, unknown>;
		const dc = dataContent(n);

		// 跳过来源/署名块（JMdict | Tatoeba）
		if (dc === "attribution") {
			return;
		}
		// sense-group：先输出其词性标签，再遍历 sense 列表
		if (dc === "sense-group") {
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			const groupTags: string[] = [];
			for (const child of arr) {
				if (typeof child !== "object" || child == null) {
					continue;
				}
				const c = child as Record<string, unknown>;
				const cdc = dataContent(c);
				if (cdc === "part-of-speech-info" || cdc === "misc-info") {
					const t = textOf(c);
					if (t) {
						groupTags.push(t);
					}
				}
			}
			if (groupTags.length > 0) {
				lines.push(`  ${groupTags.join("; ")};`);
			}
			// 遍历 sense 列表（ol > li[sense]）
			for (const child of arr) {
				if (typeof child !== "object" || child == null) {
					continue;
				}
				const c = child as Record<string, unknown>;
				if (c.tag === "ol") {
					const senses = collectTag(c, "li").filter(
						(li) => dataContent(li) === "sense",
					);
					for (const s of senses) {
						renderSense(s);
					}
				}
			}
			return;
		}
		// 兼容：裸 sense 节点
		if (dc === "sense") {
			renderSense(n);
			return;
		}
		// structured-content / 容器节点：递归
		if (
			n.type === "structured-content" ||
			n.type === "structured" ||
			n.content !== undefined
		) {
			walk(n.content);
		}
	};

	walk(glossary);

	// 兜底：若结构化解析无产出（非 Jitendex 的纯文本 glossary），
	// 把所有文本拼成一条释义。
	if (lines.length === 0) {
		const flat = textOf(glossary);
		if (flat) {
			lines.push(`  ${flat}`);
		}
	}
	return lines;
}
