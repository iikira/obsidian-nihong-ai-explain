import { Notice, TFile, type Vault } from "obsidian";
import { EXPLAIN_SYSTEM_PROMPT } from "../prompts";
import { ensureFolder, MAX_WORD_LEN, resolveTargetPath } from "../utils";
import {
	CallLogger,
	callChatCompletion,
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
				const res = await this.callModel(messages, group, logger);
				content = res.content;
				if (res.usage) {
					logger.setUsage(res.usage);
				}
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
