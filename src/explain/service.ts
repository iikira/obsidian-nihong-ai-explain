import { type Vault } from "obsidian";
import { EXPLAIN_SYSTEM_PROMPT } from "../prompts";
import { MAX_WORD_LEN } from "../utils";
import type { ModelGroup } from "../settings";
import { toAccentCircle, renderTermEntry } from "./renderTerm";
import { renderNamesDictTerm } from "../dictionary/tagZh";
import type { LookupResult } from "../dictionary/types";
import { logWarn, errMsg } from "../log";
import {
	BaseNoteService,
	type NoteServiceConfig,
	type NoteServiceSpec,
	type NoteUserContent,
} from "../noteService";

/** 讲解用到的设置项子集 */
interface ExplainConfig extends NoteServiceConfig {
	outputDir: string;
}

export interface ExplainServiceOptions {
	settings: () => ExplainConfig;
	getModelGroup: () => ModelGroup;
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	vault: () => Vault;
	/** 查离线词典（未加载/未导入时返回空数组） */
	lookup: (text: string) => Promise<LookupResult[]>;
	/** 离线词典是否已导入可用 */
	isDictionaryReady: () => boolean;
	/** 查声调（无数据返回空数组） */
	getAccents: (expression: string, reading: string) => number[];
}

/** 讲解服务：封装大模型调用、词典参考注入与落盘编排。公共骨架继承 BaseNoteService。 */
export class ExplainService extends BaseNoteService<ExplainConfig> {
	private readonly dictOpts: Pick<
		ExplainServiceOptions,
		"lookup" | "isDictionaryReady" | "getAccents"
	>;

	constructor(opts: ExplainServiceOptions) {
		super(opts);
		this.dictOpts = opts;
	}

	protected get spec(): NoteServiceSpec {
		return {
			actionId: "explain",
			maxInputLen: MAX_WORD_LEN,
			taskBusyNotice: "AI 讲解任务进行中",
			actionName: "AI 讲解",
			systemPrompt: EXPLAIN_SYSTEM_PROMPT,
		};
	}

	protected resolveOutputDir(cfg: ExplainConfig): string {
		return cfg.outputDir;
	}

	protected async buildUserContent(clean: string): Promise<NoteUserContent> {
		// 查离线词典（异步），命中则把结果作为参考拼进 user prompt；构造后由基类 throwIfCancelled
		const dictRef = await this.buildDictionaryReference(clean);
		return {
			content: dictRef
				? `请讲解以下日语单词：${clean}\n\n` +
					`该日语单词的词典查询结果如下，用于参考\n` +
					"```\n" + dictRef + "\n```\n"
				: `请讲解以下日语单词：${clean}`,
			throwIfCancelled: undefined,
		};
	}

	/**
	 * 查离线词典并把结果格式化成参考文本（含声调、词性标签、释义、例句）。
	 * 格式仿照词典弹窗的前端展示，按 expression|reading 分组，词头一行，
	 * 其下逐 sense-group 输出词性标签、义项序号与释义、例句。
	 * 词典未导入/未加载/查无结果时返回空字符串。
	 */
	private async buildDictionaryReference(word: string): Promise<string> {
		if (!this.dictOpts.isDictionaryReady()) {
			return "";
		}
		let results: LookupResult[] = [];
		try {
			results = await this.dictOpts.lookup(word);
		} catch (e) {
			logWarn("explain", `词典查询失败: ${errMsg(e)}`);
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
			// JMnedict 风格：reading 为空，glossary 是读音列表（与 popup 一致：tag + 读音）
			const isNamesDict = reading === "";
			if (!isNamesDict) {
				const accents = this.dictOpts.getAccents(expression, reading);
				const accentStr = accents.length
					? " " + accents.map((p) => toAccentCircle(p)).join(",")
					: "";
				lines.push(`${expression} | ${reading}${accentStr}`);
			} else {
				lines.push(`${expression}`);
			}
			// 同一词头下多个 LookupResult（含不同变形来源）合并渲染。
			for (const term of groupTerms) {
				if (isNamesDict) {
					// names dict：tag + 读音列表（与 popup 一致，无序号），纯函数渲染保证一致
					lines.push(renderNamesDictTerm(term.tags, term.glossary));
				} else {
					// Jitendex：词性、义项序号、释义、例句在 glossary 结构化内容里，交由 renderTermEntry 解析
					for (const line of renderTermEntry(term.glossary)) {
						lines.push(line);
					}
				}
			}
		}
		return lines.join("\n");
	}
}
