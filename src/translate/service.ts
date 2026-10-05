import { Notice } from "obsidian";
import { TranslateCard } from "./card";
import { LRUTranslateCache } from "./cache";
import { TRANSLATE_SYSTEM_PROMPT } from "../prompts";
import { centerRect } from "../popupUtils";
import type { ModelGroup } from "../settings";
import {
	CallLogger,
	callChatCompletion,
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

	/**
	 * 发起大模型调用（非流式 requestUrl，无跨域限制），带重试；返回 content + usage。
	 * 重试、耗时、成败统一记进 logger。
	 */
	private async callModel(
		messages: ChatMessage[],
		group: ModelGroup,
		temperature: number | undefined,
		logger: CallLogger,
	): Promise<{ content: string; usage: UsageInfo | null }> {
		const { maxRetries, retryInterval } = this.opts.settings();
		return callChatCompletion(messages, group, temperature, {
			maxRetries,
			retryInterval,
			logger,
		});
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
				const { content: result, usage } = await this.callModel(
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
