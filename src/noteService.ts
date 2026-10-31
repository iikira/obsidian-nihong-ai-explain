import { Notice, TFile, type Vault } from "obsidian";
import {
	CallLogger,
	callChatCompletion,
	type ChatMessage,
	type UsageInfo,
} from "./shared";
import { ensureFolder, hasForbiddenFileNameChar, resolveTargetPath } from "./utils";
import type { ModelGroup } from "./settings";
import { logError, errMsg } from "./log";
import { CancelledError, showCancellableProgress, throwIfCancelled } from "./cancel";

/**
 * 笔记生成服务的共享基类：AI 讲解（ExplainService）与语法拆解（GrammarService）同构，
 * 仅在 actionId / 最大输入长度 / 输出目录字段 / 系统提示词 / user 内容构造 上不同。
 * 本基类封装公共骨架：重入守卫、长度/非法字符校验、落盘去重、可取消进度、callModel 重试、
 * 取消/错误处理、写文件。子类只覆写抽象差异点，消除 ~80 行重复。
 */

/** 子类需提供的笔记生成差异配置 */
export interface NoteServiceSpec {
	/** 动作 id（重入守卫 key + 取消进度标签 + 日志 source） */
	readonly actionId: string;
	/** 输入文本最大字符数（超长直接报错） */
	readonly maxInputLen: number;
	/** 任务进行中的提示文案（如「AI 讲解任务进行中」） */
	readonly taskBusyNotice: string;
	/** 动作名（用于超长提示，如「AI 讲解」「语法拆解」） */
	readonly actionName: string;
	/** 系统提示词常量 */
	readonly systemPrompt: string;
}

/** 笔记生成服务的共享设置项子集（temperature/maxRetries/retryInterval 三服务一致） */
export interface NoteServiceConfig {
	temperature: number;
	maxRetries: number;
	retryInterval: number;
}

/** 笔记生成服务的共享选项 */
export interface NoteServiceOptions<C extends NoteServiceConfig> {
	settings: () => C;
	getModelGroup: () => ModelGroup;
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	vault: () => Vault;
}

/** 子类构造的中间态：callModel 前的 user 内容（含可选的取消检查点） */
export interface NoteUserContent {
	/** user 消息内容 */
	content: string;
	/** 可选：构造 user 内容过程中若需查词典等异步操作，提供取消检查点（已取消则抛 CancelledError） */
	throwIfCancelled?: () => void;
}

/**
 * 笔记生成服务基类。子类需实现：
 * - {@link spec}: 差异配置
 * - {@link resolveOutputDir}: 从设置取输出目录字段
 * - {@link buildUserContent}: 构造 user 消息内容（explain 注入词典参考，grammar 直接用原文）
 */
export abstract class BaseNoteService<C extends NoteServiceConfig> {
	protected constructor(protected readonly opts: NoteServiceOptions<C>) {}

	/** 子类提供的差异配置（actionId/maxInputLen/systemPrompt 等） */
	protected abstract get spec(): NoteServiceSpec;
	/** 从设置取输出目录字段（explain=cfg.outputDir，grammar=cfg.grammarOutputDir） */
	protected abstract resolveOutputDir(cfg: C): string;
	/** 构造 user 消息内容（explain 注入词典参考，grammar 直接用原文） */
	protected abstract buildUserContent(clean: string): Promise<NoteUserContent>;

	/** 发起大模型调用（非流式 requestUrl，无跨域限制），带重试；返回 content + usage */
	private async callModel(
		messages: ChatMessage[],
		group: ModelGroup,
		logger: CallLogger,
		isCancelled?: () => boolean,
	): Promise<{ content: string; usage: UsageInfo | null }> {
		const { temperature, maxRetries, retryInterval } = this.opts.settings();
		return callChatCompletion(messages, group, temperature, {
			maxRetries,
			retryInterval,
			logger,
			isCancelled,
		});
	}

	/** 生成笔记主流程：校验 → 落盘去重 → 可取消进度 → callModel → 写文件 */
	async explain(text: string): Promise<void> {
		const { actionId, maxInputLen, taskBusyNotice, actionName, systemPrompt } = this.spec;
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.opts.tryStartTask(actionId, clean)) {
			new Notice(`「${clean}」${taskBusyNotice}`);
			return;
		}
		const logSource = actionId;
		try {
			const cfg = this.opts.settings();
			if (clean.length > maxInputLen) {
				new Notice(
					`选区过长（${clean.length} 字符），${actionName}最多 ${maxInputLen} 字符`,
					8000,
				);
				return;
			}
			if (hasForbiddenFileNameChar(clean)) {
				new Notice(
					"选区含文件名非法字符（\\ / : * ? \" < > |），无法生成笔记",
					8000,
				);
				return;
			}

			const vault = this.opts.vault();
			const targetPath = resolveTargetPath(clean, this.resolveOutputDir(cfg));
			const existing = vault.getAbstractFileByPath(targetPath);
			if (existing instanceof TFile) {
				new Notice(`已存在，跳过: ${targetPath}`);
				return;
			}

			const { notice, token } = showCancellableProgress(actionId);
			const group = this.opts.getModelGroup();

			// 构造 user 内容（子类实现：explain 注入词典参考，grammar 直接用原文）
			const userContent = await this.buildUserContent(clean);
			if (userContent.throwIfCancelled) {
				userContent.throwIfCancelled();
			}

			const messages: ChatMessage[] = [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent.content },
			];

			let content = "";
			const logger = new CallLogger("llm");
			try {
				const res = await this.callModel(messages, group, logger, () => token.cancelled);
				throwIfCancelled(token);
				content = res.content;
				if (res.usage) {
					logger.setUsage(res.usage);
				}
			} catch (e) {
				if (e instanceof CancelledError) {
					notice.hide();
					new Notice("已取消");
					logger.flush();
					return;
				}
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`生成失败: ${msg}`, 8000);
				logError(logSource, `生成失败: ${errMsg(e)}`);
				logger.flush();
				return;
			}
			logger.flush();

			throwIfCancelled(token);
			const dir = (this.resolveOutputDir(cfg) ?? "").trim();
			try {
				if (dir) {
					await ensureFolder(vault, dir);
				}
				throwIfCancelled(token);
				await vault.create(targetPath, content);
			} catch (e) {
				if (e instanceof CancelledError) {
					notice.hide();
					new Notice("已取消");
					return;
				}
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`写入文件失败: ${msg}`, 8000);
				logError(logSource, `写入失败: ${errMsg(e)}`);
				return;
			}

			notice.hide();
			new Notice(`已生成: ${targetPath}`);
		} finally {
			this.opts.finishTask(actionId, clean);
		}
	}
}
