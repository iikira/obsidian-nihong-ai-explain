import { Notice } from "obsidian";
import { TranslateCard } from "./card";
import { LRUTranslateCache } from "./cache";
import { TRANSLATE_SYSTEM_PROMPT } from "../prompts";
import { centerRect } from "../popupUtils";
import type { ModelGroup } from "../settings";
import {
	buildDisableThinking,
	CallLogger,
	type ChatCompletionResponse,
	type ChatMessage,
	type UsageInfo,
} from "../shared";

/** 翻译用到的设置项子集 */
interface TranslateConfig {
	targetLanguage: string;
	temperature: number;
	maxRetries: number;
	retryInterval: number;
}

export interface TranslateServiceOptions {
	/** 读取翻译相关设置 */
	settings: () => TranslateConfig;
	/** 获取翻译用的大模型分组 */
	getModelGroup: () => ModelGroup;
	/** 占用/释放任务槽（沿用插件全局防重入） */
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	/** 读取当前选区位置 */
	getSelectionRect: () => DOMRect | null;
}

/** 翻译服务：封装翻译网络调用、缓存与 UI 编排。 */
export class TranslateService {
	private readonly opts: TranslateServiceOptions;
	readonly cache: LRUTranslateCache;
	private readonly card: TranslateCard;

	constructor(opts: TranslateServiceOptions) {
		this.opts = opts;
		this.cache = new LRUTranslateCache();
		this.cache.load();
		this.card = new TranslateCard();
	}

	/** 卸载时刷新缓存并关闭卡片 */
	onUnload(): void {
		this.cache.flush();
		this.card.hide();
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	/** 解析 SSE 流式响应，聚合 content / usage */
	private async parseStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<{ content: string; usage: UsageInfo | null }> {
		const decoder = new TextDecoder();
		const contentParts: string[] = [];
		let usage: UsageInfo | null = null;
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (let line of lines) {
				line = line.trim();
				if (!line.startsWith("data:")) {
					continue;
				}
				const chunk = line.slice(5).trim();
				if (chunk === "[DONE]") {
					continue;
				}
				let obj: ChatCompletionResponse;
				try {
					obj = JSON.parse(chunk) as ChatCompletionResponse;
				} catch {
					continue;
				}
				if (obj.usage) {
					usage = extractUsage(obj);
				}
				const ch = obj.choices?.[0];
				const delta = ch?.delta;
				if (delta?.content) {
					contentParts.push(delta.content);
				}
			}
		}
		return { content: contentParts.join(""), usage };
	}

	/** 发起流式请求（单次，带重试在外层），返回 content + usage */
	private async callModelOnce(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature: number | undefined,
		logger: CallLogger,
	): Promise<{ content: string; usage: UsageInfo | null }> {
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
			temperature: temperature ?? this.opts.settings().temperature,
			stream: true,
		};
		Object.assign(body, buildDisableThinking(group.modelId));
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
			let res: { content: string; usage: UsageInfo | null };
			try {
				res = await this.parseStream(reader);
			} finally {
				reader.releaseLock();
			}
			if (!res.content.trim()) {
				throw new Error("响应 content 为空");
			}
			const ms = Math.round((performance.now() - t0) * 100) / 100;
			logger.recordAttempt({ ok: true, ms });
			return res;
		} catch (e) {
			const ms = Math.round((performance.now() - t0) * 100) / 100;
			logger.recordAttempt({ ok: false, ms });
			throw e;
		}
	}

	private async callModelWithRetry(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature: number | undefined,
		logger: CallLogger,
	): Promise<{ content: string; usage: UsageInfo | null }> {
		const { maxRetries, retryInterval } = this.opts.settings();
		const max = Math.max(0, maxRetries);
		let lastErr: unknown = null;
		for (let attempt = 1; attempt <= max; attempt++) {
			try {
				return await this.callModelOnce(
					messages,
					group,
					temperature,
					logger,
				);
			} catch (e) {
				lastErr = e;
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(
					`[nihong-ai-explain] 第 ${attempt}/${max} 次失败: ${msg}`
				);
				if (attempt < max) {
					await this.sleep(retryInterval);
				}
			}
		}
		const finalMsg =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new Error(`重试 ${max} 次后仍失败: ${finalMsg}`);
	}

	async translate(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.opts.tryStartTask("translate", clean)) {
			new Notice(`「${clean}」翻译任务进行中`);
			return;
		}
		try {
			const target = this.opts.settings().targetLanguage || "中文";
			const cacheKey = JSON.stringify({ text: clean, target });
			const rect = this.opts.getSelectionRect() ?? centerRect();

			// 缓存命中：静默显示，无任何提示
			const cached = this.cache.get(cacheKey);
			if (cached != null) {
				this.card.showResult(cached, rect);
				// LRU 缓存命中：无 API 调用，无 token 用量
				console.log("[nihong-ai-explain] 翻译 LRU 缓存命中，无 API 调用");
				return;
			}

			this.card.showLoading(rect);

			const messages: ChatMessage[] = [
				{
					role: "system",
					content: TRANSLATE_SYSTEM_PROMPT(target),
				},
				{ role: "user", content: clean },
			];

			const logger = new CallLogger("nihong-ai-explain");
			try {
				const { content: result, usage } = await this.callModelWithRetry(
					messages,
					this.opts.getModelGroup(),
					0.3,
					logger,
				);
				if (usage) {
					logger.setUsage(usage);
				}
				this.cache.set(cacheKey, result);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.card.showResult(result, rectNow);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.card.showError(`翻译失败: ${msg}`, rectNow);
				console.error("[nihong-ai-explain] 翻译失败:", e);
			} finally {
				logger.flush();
			}
		} finally {
			this.opts.finishTask("translate", clean);
		}
	}
}

/** 从非流式响应的 usage 提取 token 用量（含 prompt 缓存命中）；无 usage 返回 null */
function extractUsage(data: ChatCompletionResponse): UsageInfo | null {
	const u = data.usage;
	if (!u) {
		return null;
	}
	const completion = u.completion_tokens ?? u.output_tokens ?? 0;
	const total = u.total_tokens ?? 0;
	// prompt_tokens：优先显式字段，其次 total - completion 兜底
	const prompt =
		u.prompt_tokens ?? u.input_tokens ?? (total > completion ? total - completion : 0);
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		reasoning_tokens:
			u.completion_tokens_details?.reasoning_tokens ?? 0,
		// prompt 缓存命中 token：兼容 OpenAI(prompt_tokens_details) / DeepSeek(prompt_cache_hit_tokens)
		cached_tokens:
			u.prompt_tokens_details?.cached_tokens ??
			u.prompt_cache_hit_tokens ??
			0,
	};
}
