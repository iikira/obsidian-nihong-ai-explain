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
}

export interface ChatCompletionResponse {
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

export interface PerfRecord {
	attempt: number;
	ok: boolean;
	status: number;
	ms: number;
	model: string;
	msgCount: number;
	contentLen?: number;
	error?: string;
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
