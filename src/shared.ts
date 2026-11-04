import { requestUrl } from "obsidian";
import { logInfo, logWarn, errMsg } from "./log";

/** tool_call 中的函数调用 */
export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** 支持 tool-use 的聊天消息 */
export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** 流式 SSE delta 中的 tool_calls 分片 */
export interface DeltaToolCall {
	index?: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}

export interface ChatChoice {
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

export interface UsageInfo {
	prompt_tokens: number;
	completion_tokens: number;
	reasoning_tokens: number;
	/** 思考内容字符长度（reasoning_content/reasoning 文本的 .length，无则 0） */
	reasoning_chars: number;
	/** 缓存命中的输入 token 数（prompt 缓存） */
	cached_tokens: number;
}

export interface ChatCompletionResponse {
	choices?: ChatChoice[];
	error?: { message?: string };
	usage?: {
		prompt_tokens?: number;
		input_tokens?: number;
		completion_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
		/** OpenAI 风格：prompt 缓存命中 token 数 */
		prompt_tokens_details?: { cached_tokens?: number };
		/** DeepSeek 风格：prompt 缓存命中 token 数 */
		prompt_cache_hit_tokens?: number;
	};
}

/** 单次调用记录（统一日志用）：成功/失败、耗时 */
export interface CallAttempt {
	ok: boolean;
	ms: number;
}

/**
 * 统一调用日志：累积 token 用量 + 各次尝试耗时/成败，最后通过 logger 输出一行汇总。
 * 默认不输出（遵循 lint no-console）；可注入 logger（如测试用）接收格式化后的汇总行。
 * 格式：
 *   [prefix] token: 输入=X 输出=Y 思考=Z 思考字数=W 缓存命中=N(P%)，M 次调用 · 成功 A · 失败 B · 累计 Kms · 终态 成功/失败
 * 缓存命中 N = 命中 prompt 缓存的输入 token 数；P% = N / 输入 token 的命中率；思考字数 W = 响应携带的思考文本字符数；无调用时省略调用段。
 */
export class CallLogger {
	private readonly prefix: string;
	private readonly attempts: CallAttempt[] = [];
	private usage: UsageInfo = {
		prompt_tokens: 0,
		completion_tokens: 0,
		reasoning_tokens: 0,
		reasoning_chars: 0,
		cached_tokens: 0,
	};
	/** 汇总行输出函数；默认走日志页签（logInfo），测试可注入 sink */
	private sink: (line: string) => void;

	constructor(prefix: string, sink?: (line: string) => void) {
		this.prefix = prefix;
		this.sink = sink ?? ((line) => logInfo(prefix, line));
	}

	/** 记录一次尝试（成功/失败 + 耗时） */
	recordAttempt(attempt: CallAttempt): void {
		this.attempts.push(attempt);
	}

	/** 累计 token 用量（取最后一次成功的 usage） */
	setUsage(usage: UsageInfo): void {
		this.usage = usage;
	}

	/** 输出汇总日志行（通过注入的 sink，默认无操作） */
	flush(): void {
		const u = this.usage;
		const cached = u.cached_tokens;
		const rate =
			u.prompt_tokens > 0
				? Math.round((cached / u.prompt_tokens) * 100)
				: 0;
		// 缓存命中=0 时不显示百分比，避免噪声
		const cachePart =
			cached > 0 && u.prompt_tokens > 0
				? `缓存命中=${cached}(${rate}%)`
				: `缓存命中=${cached}`;
		const tokenPart =
			`token: 输入=${u.prompt_tokens} ` +
			`输出=${u.completion_tokens} ` +
			`思考=${u.reasoning_tokens} ` +
			`思考字数=${u.reasoning_chars} ` +
			cachePart;
		if (this.attempts.length === 0) {
			// 无 API 调用（如缓存直接命中）：只输出 token 段（source 列已显示模块名）
			this.sink(tokenPart);
			return;
		}
		const okCount = this.attempts.filter((a) => a.ok).length;
		const totalMs = this.attempts.reduce((s, a) => s + a.ms, 0);
		const last = this.attempts[this.attempts.length - 1];
		this.sink(
			`${tokenPart}，` +
				`${this.attempts.length} 次调用 · 成功 ${okCount} · 失败 ${this.attempts.length - okCount} · ` +
				`累计 ${Math.round(totalMs)}ms · 终态 ${last.ok ? "成功" : "失败"}`,
		);
	}
}

/**
 * 组装"关闭思考"字段，返回要合并进请求 body 的对象。
 * 三种风格一起发、互不冲突，各后端取自己认的字段：
 * - reasoning_effort（OpenAI 风格）/ thinking.type（DeepSeek 风格）：让网关不下发思考文本；
 * - chat_template_kwargs.enable_thinking（vLLM 风格）：模板层真正不渲染思考段，
 *   仅靠前两者时 token 仍被思考消耗（实测 completion ~600 vs 关死后 ~6）。
 */
export function buildDisableThinking(_model: string): Record<string, unknown> {
	return {
		reasoning_effort: "none",
		thinking: { type: "disabled" },
		chat_template_kwargs: { enable_thinking: false },
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** 从响应的 usage 提取 token 用量（含 prompt 缓存命中）与思考内容字符长度；无 usage 返回 null */
export function extractUsage(data: ChatCompletionResponse): UsageInfo | null {
	const u = data.usage;
	if (!u) {
		return null;
	}
	const completion = u.completion_tokens ?? u.output_tokens ?? 0;
	const total = u.total_tokens ?? 0;
	// prompt_tokens：优先显式字段，其次 total - completion 兜底
	const prompt =
		u.prompt_tokens ??
		u.input_tokens ??
		(total > completion ? total - completion : 0);
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
		// 思考内容字符长度：兼容 DeepSeek(reasoning_content) / 部分网关(reasoning)
		reasoning_chars:
			(data.choices?.[0]?.message?.reasoning_content ??
				data.choices?.[0]?.message?.reasoning ??
				"").length,
		// prompt 缓存命中 token：兼容 OpenAI(prompt_tokens_details) / DeepSeek(prompt_cache_hit_tokens)
		cached_tokens:
			u.prompt_tokens_details?.cached_tokens ??
			u.prompt_cache_hit_tokens ??
			0,
	};
}

/**
 * 调用 OpenAI 兼容的 /chat/completions（非流式 requestUrl，无跨域限制）。
 * 带重试；每次尝试的成败与耗时记进 logger；成功返回 content + usage（usage 可能为 null）。
 *
 * @param messages 消息列表
 * @param group 模型分组（apiUrl/modelId/apiKey）
 * @param temperature 采样温度，undefined 用 0.7
 * @param opts 重试与日志：maxRetries/retryInterval/logger
 */
export async function callChatCompletion(
	messages: ChatMessage[],
	group: { apiUrl: string; modelId: string; apiKey: string },
	temperature: number | undefined,
	opts: {
		maxRetries: number;
		retryInterval: number;
		logger: CallLogger;
		/** 可选取消检查：在每次重试 attempt 之间检查，已取消则不再发起下一次（底层 requestUrl 无法 abort，已发出的请求可能仍跑完但结果被忽略） */
		isCancelled?: () => boolean;
	},
): Promise<{ content: string; usage: UsageInfo | null }> {
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
		temperature: temperature ?? 0.7,
		stream: false,
	};
	Object.assign(body, buildDisableThinking(group.modelId));

	const max = Math.max(0, opts.maxRetries);
	const logger = opts.logger;
	let lastErr: unknown = null;
	for (let attempt = 1; attempt <= max; attempt++) {
		// 重试前检查取消：已取消则停止重试（首次 attempt 不检查——首次调用方应在 await 前已检查）
		if (attempt > 1 && opts.isCancelled?.()) {
			throw new Error("已取消");
		}
		const t0 = performance.now();
		try {
			const resp = await requestUrl({
				url,
				method: "POST",
				headers,
				body: JSON.stringify(body),
				throw: false,
			});
			const ms = Math.round((performance.now() - t0) * 100) / 100;
			const data = resp.json as ChatCompletionResponse;
			if (resp.status < 200 || resp.status >= 300) {
				const errMsg = data?.error?.message || `HTTP ${resp.status}`;
				throw new Error(`API 请求失败: ${errMsg}`);
			}
			const choice = data.choices?.[0];
			const content = choice?.message?.content ?? "";
			if (!content.trim()) {
				throw new Error("响应 message.content 为空");
			}
			logger.recordAttempt({ ok: true, ms });
			return { content, usage: extractUsage(data) };
		} catch (e) {
			lastErr = e;
			const ms = Math.round((performance.now() - t0) * 100) / 100;
			logger.recordAttempt({ ok: false, ms });
			logWarn("llm", `第 ${attempt}/${max} 次调用失败: ${errMsg(e)}`);
			if (attempt < max) {
				await sleep(opts.retryInterval);
			}
		}
	}
	const finalMsg =
		lastErr instanceof Error ? lastErr.message : String(lastErr);
	throw new Error(`重试 ${max} 次后仍失败: ${finalMsg}`);
}
