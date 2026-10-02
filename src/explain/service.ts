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
import {
	MAX_TOOL_ROUNDS,
	MOJI_TOOL_SCHEMA,
	dispatchTool,
	type ParsedToolCall,
} from "../mojidict";
import type { ModelGroup } from "../settings";

/** 讲解用到的设置项子集 */
interface ExplainConfig {
	temperature: number;
	maxRetries: number;
	retryInterval: number;
	outputDir: string;
	mojiDeviceId: string;
	mojiToken: string;
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
}

/** 讲解服务：封装流式 tool-call 循环、token 诊断与落盘编排。 */
export class ExplainService {
	private readonly opts: ExplainServiceOptions;

	constructor(opts: ExplainServiceOptions) {
		this.opts = opts;
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
		const { temperature, maxRetries, retryInterval } =
			this.opts.settings();
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
		if (withTools) {
			body["tools"] = MOJI_TOOL_SCHEMA;
			body["tool_choice"] = "auto";
		}

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
			const deviceId = cfg.mojiDeviceId ?? "";
			const token = cfg.mojiToken ?? "";

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
