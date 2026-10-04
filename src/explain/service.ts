import { Notice, TFile, type Vault } from "obsidian";
import { EXPLAIN_SYSTEM_PROMPT } from "../prompts";
import { ensureFolder, MAX_WORD_LEN, resolveTargetPath } from "../utils";
import {
	buildDisableThinking,
	CallLogger,
	sleep,
	type ChatCompletionResponse,
	type ChatMessage,
	type UsageInfo,
} from "../shared";
import { toAccentCircle, renderTermEntry } from "./renderTerm";
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
			cached_tokens: 0,
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
						// prompt 缓存命中 token：兼容 OpenAI(prompt_tokens_details) / DeepSeek(prompt_cache_hit_tokens)
						cached_tokens:
							u.prompt_tokens_details?.cached_tokens ??
							u.prompt_cache_hit_tokens ??
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
		logger: CallLogger,
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
			const t0 = performance.now();
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
					const res = await this.parseStream(reader);
					logger.recordAttempt({
						ok: true,
						ms: performance.now() - t0,
					});
					return res;
				} finally {
					reader.releaseLock();
				}
			} catch (e) {
				lastErr = e;
				logger.recordAttempt({
					ok: false,
					ms: performance.now() - t0,
				});
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
			const logger = new CallLogger("nihong-ai-explain");
			try {
				const res = await this.callStream(messages, group, logger);
				content = res.content;
				logger.setUsage(res.usage);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`生成失败: ${msg}`, 8000);
				console.error("[nihong-ai-explain] 生成失败:", e);
				logger.flush();
				return;
			}
			logger.flush();

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
