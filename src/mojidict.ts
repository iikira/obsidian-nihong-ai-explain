import { requestUrl } from "obsidian";

/** MOJI 搜索接口 */
const MOJI_SEARCH_URL =
	"https://api.mojidict.com/app/mojidict/api/v1/search/all" +
	"?text={text}&types=102&types=106&types=103&types=671&highlight=true";

/** tool-use 循环最大轮数（含最终讲解轮） */
export const MAX_TOOL_ROUNDS = 6;

/** 大模型 tool_call 工具定义：引导讲解日语单词前先查词典 */
export const MOJI_TOOL_SCHEMA = [
	{
		type: "function" as const,
		function: {
			name: "search_dictionary",
			description:
				"查询 MOJI 词典，获取日语单词的释义、声调、词性、例句等参考信息。" +
				"形容词/动词等变形必须用原型（辞书形）去查。" +
				"讲解日语单词前必须先调用本工具查询。",
			parameters: {
				type: "object",
				properties: {
					word: {
						type: "string",
						description: "要查询的日语单词原型（辞书形）",
					},
				},
				required: ["word"],
			},
		},
	},
];

export interface MojiItem {
	title: string;
	excerpt: string;
}

export interface MojiResult {
	word: MojiItem[];
	grammar: MojiItem[];
	example: MojiItem[];
}

const EMPTY_RESULT: MojiResult = { word: [], grammar: [], example: [] };

/**
 * 调用 mojidict 搜索接口，返回精简后的参考信息。
 * 当 deviceId / token 为空时，不带 X-Moji-Device-Id / X-Moji-Session-Id /
 * X-Moji-Token 请求头。请求失败返回空结构，不抛异常。
 */
export async function searchMojidict(
	word: string,
	deviceId: string,
	token: string,
): Promise<MojiResult> {
	const url = MOJI_SEARCH_URL.replace(
		"{text}",
		encodeURIComponent(word),
	);
	const headers: Record<string, string> = {
		Accept: "application/json, text/plain, */*",
		"Accept-Language": "ja,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-CN;q=0.6",
		Origin: "https://www.mojidict.com",
		Referer: "https://www.mojidict.com/",
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
			"AppleWebKit/537.36 (KHTML, like Gecko) " +
			"Chrome/146.0.0.0 Safari/537.36",
		"X-Moji-App-Id": "com.mojitec.mojidict",
		"X-Moji-App-Version": "4.15.12",
		"X-Moji-Os": "PCWeb",
	};
	if (deviceId) {
		headers["X-Moji-Device-Id"] = deviceId;
	}
	if (token) {
		headers["X-Moji-Session-Id"] = token;
		headers["X-Moji-Token"] = token;
	}

	try {
		const resp = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});
		if (resp.status < 200 || resp.status >= 300) {
			console.warn(
				`[nihong-ai-explain] mojidict 查询 HTTP ${resp.status}`,
			);
			return EMPTY_RESULT;
		}
		const obj = resp.json as Record<string, unknown>;

		const pick = (section: string): MojiItem[] => {
			const sec = (obj[section] as { list?: unknown }) ?? {};
			const items = (sec.list as Record<string, unknown>[]) ?? [];
			return items.map((it) => ({
				title: String(it.title ?? ""),
				excerpt: String(it.excerpt ?? ""),
			}));
		};

		return {
			word: pick("word"),
			grammar: pick("grammar"),
			example: pick("example"),
		};
	} catch (e) {
		console.warn(`[nihong-ai-explain] mojidict 查询失败:`, e);
		return EMPTY_RESULT;
	}
}

/** 把 searchMojidict 的结果格式化成简短文本 */
export function formatMojiReference(
	result: MojiResult,
	limitEach = 5,
): string {
	const lines: string[] = [];
	if (result.word.length) {
		lines.push("【词典释义】");
		for (const it of result.word.slice(0, limitEach)) {
			lines.push(`- ${it.title}：${it.excerpt}`);
		}
	}
	if (result.grammar.length) {
		lines.push("【语法】");
		for (const it of result.grammar.slice(0, limitEach)) {
			lines.push(`- ${it.title}：${it.excerpt}`);
		}
	}
	if (result.example.length) {
		lines.push("【例句】");
		for (const it of result.example.slice(0, limitEach)) {
			lines.push(`- ${it.title}：${it.excerpt}`);
		}
	}
	return lines.length ? lines.join("\n") : "(无参考信息)";
}

/** tool_call 请求参数（name + 已解析的 arguments） */
export interface ParsedToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** 原始 arguments 字符串，回灌 assistant 消息时用 */
	argumentsRaw: string;
}

/**
 * 把模型发起的 tool_call 分发到本地实现，返回给模型的字符串结果。
 * 未知工具或参数缺失时返回错误提示字符串，不抛异常。
 */
export async function dispatchTool(
	name: string,
	args: Record<string, unknown>,
	deviceId: string,
	token: string,
): Promise<string> {
	if (name === "search_dictionary") {
		const word = String(args.word ?? "").trim();
		if (!word) {
			return "错误：缺少参数 word";
		}
		const result = await searchMojidict(word, deviceId, token);
		console.log(
			`[nihong-ai-explain] mojidict 查询「${word}」-> ` +
				`word=${result.word.length} ` +
				`grammar=${result.grammar.length} ` +
				`example=${result.example.length}`,
		);
		return formatMojiReference(result);
	}
	return `错误：未知工具 ${name}`;
}
