import type { TtsEngine } from "../tts";

/** 大模型分组：一组 apiUrl / modelId / apiKey，可复用于讲解/翻译/语法拆解。 */
export interface ModelGroup {
	/** 分组唯一 id（uuid 或固定字符串） */
	id: string;
	/** 显示名称 */
	name: string;
	/** API 根地址 */
	apiUrl: string;
	/** 模型 id */
	modelId: string;
	/** API Key，可选 */
	apiKey: string;
}

export interface NihongAIExplainSettings {
	/** 笔记输出目录，相对 vault 根，空字符串=根目录 */
	outputDir: string;
	/** 语法拆解输出目录，相对 vault 根，空字符串=根目录 */
	grammarOutputDir: string;
	/** 大模型分组列表 */
	modelGroups: ModelGroup[];
	/** 当前在设置页编辑的分组 id */
	activeModelGroupId: string;
	/** AI 讲解用的大模型分组 id */
	explainModelGroupId: string;
	/** 语法拆解用的大模型分组 id */
	grammarModelGroupId: string;
	/** 翻译用的大模型分组 id */
	translateModelGroupId: string;
	/** 采样温度 */
	temperature: number;
	/** 最大重试次数 */
	maxRetries: number;
	/** 重试间隔（毫秒） */
	retryInterval: number;
	/** 单次请求超时（毫秒） */
	requestTimeout: number;
	/** 翻译目标语言 */
	targetLanguage: string;
	/** 词典卡片字号（px），0=使用默认 */
	dictFontSize: number;
	/** TTS 朗读语速（0.5–3.0，1.0=正常） */
	ttsRate: number;
	/** TTS 引擎：google / windows */
	ttsEngine: TtsEngine;
	/** windows 引擎语音 DisplayName（OneCore 自然语音，如 Microsoft Ayumi） */
	ttsWindowsVoice: string;
	/** google 引擎自定义域名（如 google-translate-vercel.roojay.com），空=官方域名 */
	ttsGoogleDomain: string;
	/** 禁用 Lexis 选区悬浮窗（开启后改用本插件自带 pill） */
	disableLexisPill: boolean;
}


export const DEFAULT_SETTINGS: NihongAIExplainSettings = {
	outputDir: "",
	grammarOutputDir: "",
	modelGroups: [
		{
			id: "default",
			name: "默认",
			apiUrl: "https://api.deepseek.com/v1",
			modelId: "deepseek-flash",
			apiKey: "",
		},
	],
	activeModelGroupId: "default",
	explainModelGroupId: "default",
	grammarModelGroupId: "default",
	translateModelGroupId: "default",
	temperature: 0.7,
	maxRetries: 3,
	retryInterval: 2000,
	requestTimeout: 120000,
	targetLanguage: "中文",
	dictFontSize: 0,
	ttsRate: 1.0,
	ttsEngine: "google",
	ttsWindowsVoice: "",
	ttsGoogleDomain: "",
	disableLexisPill: false,
};
