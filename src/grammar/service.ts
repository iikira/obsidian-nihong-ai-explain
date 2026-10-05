import { Notice, TFile, type Vault } from "obsidian";
import { GRAMMAR_SYSTEM_PROMPT } from "../prompts";
import { ensureFolder, hasForbiddenFileNameChar, MAX_WORD_LEN, resolveTargetPath } from "../utils";
import {
	CallLogger,
	callChatCompletion,
	type ChatMessage,
	type UsageInfo,
} from "../shared";
import type { ModelGroup } from "../settings";

/** 语法拆解用到的设置项子集 */
interface GrammarConfig {
	temperature: number;
	maxRetries: number;
	retryInterval: number;
	/** 语法拆解输出目录（相对 vault 根，空=根目录） */
	grammarOutputDir: string;
}

export interface GrammarServiceOptions {
	/** 读取语法拆解相关设置 */
	settings: () => GrammarConfig;
	/** 获取语法拆解用的大模型分组 */
	getModelGroup: () => ModelGroup;
	/** 占用/释放任务槽（沿用插件全局防重入） */
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	/** 当前 vault */
	vault: () => Vault;
}

/** 语法拆解服务：封装大模型调用与落盘编排。与 AI 讲解同构，仅提示词/输出目录/模型分组独立。 */
export class GrammarService {
	private readonly opts: GrammarServiceOptions;

	constructor(opts: GrammarServiceOptions) {
		this.opts = opts;
	}

	/**
	 * 发起大模型调用（非流式 requestUrl，无跨域限制），带重试；返回 content + usage。
	 * 重试、耗时、成败统一记进 logger；token 用量在调用方 setUsage 后 flush。
	 */
	private async callModel(
		messages: ChatMessage[],
		group: ModelGroup,
		logger: CallLogger,
	): Promise<{ content: string; usage: UsageInfo | null }> {
		const { temperature, maxRetries, retryInterval } = this.opts.settings();
		return callChatCompletion(messages, group, temperature, {
			maxRetries,
			retryInterval,
			logger,
		});
	}

	async explain(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.opts.tryStartTask("grammar", clean)) {
			new Notice(`「${clean}」语法拆解任务进行中`);
			return;
		}
		try {
			const cfg = this.opts.settings();
			if (clean.length > MAX_WORD_LEN) {
				new Notice(
					`选区过长（${clean.length} 字符），已截断使用前 ${MAX_WORD_LEN} 字符`,
				);
			}
			if (hasForbiddenFileNameChar(clean)) {
				new Notice(
					"选区含文件名非法字符（\\ / : * ? \" < > |），无法生成笔记",
					8000,
				);
				return;
			}

			const vault = this.opts.vault();
			const targetPath = resolveTargetPath(clean, cfg.grammarOutputDir);
			const existing = vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				new Notice(`已存在，跳过: ${targetPath}`);
				return;
			}

			new Notice("正在生成…");
			const group = this.opts.getModelGroup();

			const messages: ChatMessage[] = [
				{ role: "system", content: GRAMMAR_SYSTEM_PROMPT },
				{ role: "user", content: clean },
			];

			let content = "";
			const logger = new CallLogger("nihong-ai-explain");
			try {
				const res = await this.callModel(messages, group, logger);
				content = res.content;
				if (res.usage) {
					logger.setUsage(res.usage);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`生成失败: ${msg}`, 8000);
				console.error("[nihong-ai-explain] 语法拆解失败:", e);
				logger.flush();
				return;
			}
			logger.flush();

			const dir = (cfg.grammarOutputDir ?? "").trim();
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
			this.opts.finishTask("grammar", clean);
		}
	}
}
