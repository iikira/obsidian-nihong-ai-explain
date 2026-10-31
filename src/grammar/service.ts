import { type Vault } from "obsidian";
import { GRAMMAR_SYSTEM_PROMPT } from "../prompts";
import type { ModelGroup } from "../settings";
import {
	BaseNoteService,
	type NoteServiceConfig,
	type NoteServiceSpec,
	type NoteUserContent,
} from "../noteService";

/** 语法拆解输入文本最大字符数：超过直接报错（语法拆解面向单句，过长无意义且浪费 token） */
const GRAMMAR_MAX_INPUT_LEN = 200;

/** 语法拆解用到的设置项子集 */
interface GrammarConfig extends NoteServiceConfig {
	/** 语法拆解输出目录（相对 vault 根，空=根目录） */
	grammarOutputDir: string;
}

export interface GrammarServiceOptions {
	settings: () => GrammarConfig;
	getModelGroup: () => ModelGroup;
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	vault: () => Vault;
}

/** 语法拆解服务：封装大模型调用与落盘编排。公共骨架继承 BaseNoteService，无词典注入。 */
export class GrammarService extends BaseNoteService<GrammarConfig> {
	constructor(opts: GrammarServiceOptions) {
		super(opts);
	}

	protected get spec(): NoteServiceSpec {
		return {
			actionId: "grammar",
			maxInputLen: GRAMMAR_MAX_INPUT_LEN,
			taskBusyNotice: "语法拆解任务进行中",
			actionName: "语法拆解",
			systemPrompt: GRAMMAR_SYSTEM_PROMPT,
		};
	}

	protected resolveOutputDir(cfg: GrammarConfig): string {
		return cfg.grammarOutputDir;
	}

	protected async buildUserContent(clean: string): Promise<NoteUserContent> {
		// 语法拆解无词典参考注入，直接用原文作 user 内容
		return { content: clean };
	}
}
