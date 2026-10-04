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
 * 统一调用日志：累积 token 用量 + 各次尝试耗时/成败，最后打印一行汇总。
 * 格式：
 *   [prefix] token: 输入=X 输出=Y 思考=Z 缓存命中=N(P%)，M 次调用 · 成功 A · 失败 B · 累计 Kms · 终态 成功/失败
 * 缓存命中 N = 命中 prompt 缓存的输入 token 数；P% = N / 输入 token 的命中率；无调用时省略调用段。
 */
export class CallLogger {
	private readonly prefix: string;
	private readonly attempts: CallAttempt[] = [];
	private usage: UsageInfo = {
		prompt_tokens: 0,
		completion_tokens: 0,
		reasoning_tokens: 0,
		cached_tokens: 0,
	};

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	/** 记录一次尝试（成功/失败 + 耗时） */
	recordAttempt(attempt: CallAttempt): void {
		this.attempts.push(attempt);
	}

	/** 累计 token 用量（取最后一次成功的 usage） */
	setUsage(usage: UsageInfo): void {
		this.usage = usage;
	}

	/** 打印汇总日志行 */
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
			cachePart;
		if (this.attempts.length === 0) {
			// 无 API 调用（如缓存直接命中）：只输出 token 段
			console.log(`[${this.prefix}] ${tokenPart}`);
			return;
		}
		const okCount = this.attempts.filter((a) => a.ok).length;
		const totalMs = this.attempts.reduce((s, a) => s + a.ms, 0);
		const last = this.attempts[this.attempts.length - 1];
		console.log(
			`[${this.prefix}] ${tokenPart}，` +
				`${this.attempts.length} 次调用 · 成功 ${okCount} · 失败 ${this.attempts.length - okCount} · ` +
				`累计 ${Math.round(totalMs)}ms · 终态 ${last.ok ? "成功" : "失败"}`,
		);
	}
}

/**
 * 按模型 id 动态组装"关闭思考"字段，返回要合并进请求 body 的对象。
 * - hy3-free：OpenAI 风格 { reasoning_effort: "none" }
 * - 含 deepseek-v4：DeepSeek 风格 { thinking: { type: "disabled" } }
 * - 其他：默认 OpenAI 风格 { reasoning_effort: "none" }
 */
export function buildDisableThinking(model: string): Record<string, unknown> {
	if (model.includes("deepseek-v4")) {
		return { thinking: { type: "disabled" } };
	}
	return { reasoning_effort: "none" };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
