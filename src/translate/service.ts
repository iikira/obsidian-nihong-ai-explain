import { Notice, requestUrl } from "obsidian";
import { TranslateCard } from "./card";
import { LRUTranslateCache } from "./cache";
import { TRANSLATE_SYSTEM_PROMPT } from "../prompts";
import { centerRect } from "../popupUtils";
import type { ModelGroup } from "../settings";
import {
	buildDisableThinking,
	type ChatCompletionResponse,
	type ChatMessage,
	type PerfRecord,
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
	private perfRecords: PerfRecord[] = [];

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
			temperature: temperature ?? this.opts.settings().temperature,
			stream: false,
		};
		Object.assign(body, buildDisableThinking(group.modelId));
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
				const errMsg = data?.error?.message || `HTTP ${resp.status}`;
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

	private async callModelWithRetry(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature?: number,
	): Promise<string> {
		const { maxRetries, retryInterval } = this.opts.settings();
		const max = Math.max(0, maxRetries);
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
					await this.sleep(retryInterval);
				}
			}
		}
		this.flushPerfTable();
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

			try {
				const result = await this.callModelWithRetry(
					messages,
					this.opts.getModelGroup(),
					0.3,
				);
				this.cache.set(cacheKey, result);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.card.showResult(result, rectNow);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.card.showError(`翻译失败: ${msg}`, rectNow);
				console.error("[nihong-ai-explain] 翻译失败:", e);
			}
		} finally {
			this.opts.finishTask("translate", clean);
		}
	}
}
