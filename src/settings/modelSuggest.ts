import {
	AbstractInputSuggest,
	prepareFuzzySearch,
	requestUrl,
	type App,
} from "obsidian";
import { logInfo, logWarn } from "../log";

/** 模型列表缓存项：按 apiUrl+apiKey 维度缓存，避免每次输入都请求端点 */
interface ModelListCacheItem {
	/** 缓存键（apiUrl + apiKey 拼接），用于命中判断 */
	key: string;
	/** 拉取到的模型 id 列表 */
	ids: string[];
	/** 过期时间戳（Date.now() 毫秒）；超过此时间视为未命中，重新拉取 */
	expiresAt: number;
}

/** 模型列表缓存有效期（毫秒）：仅成功拉取才缓存，60 秒后过期 */
const MODEL_LIST_CACHE_TTL = 60_000;

/** 会话内模型列表缓存（单条，LRU 风格：新请求覆盖旧条目） */
let modelListCache: ModelListCacheItem | null = null;

/**
 * 缓存键：基于规范化后的 base（已去末尾斜杠）与 apiKey，换端点或换 key 都会重新拉取。
 * 用规范化 base 而非原始 apiUrl，使 /v1 与 /v1/ 视为同端点命中缓存。
 */
function cacheKey(base: string, apiKey: string): string {
	return `${base}::${apiKey}`;
}

/**
 * 一次模型列表请求的返回形状（仅取 fetchModelIds 用到的字段）。
 * 生产由 Obsidian requestUrl 提供，测试可注入 mock。
 */
export interface ModelListResponse {
	/** HTTP 状态码 */
	status: number;
	/** 响应体（端点 /models 返回的 { data: [{ id }] }） */
	json: { data?: { id?: string }[] };
}

/**
 * 模型列表拉取器：生产默认用 Obsidian requestUrl，测试可注入 mock。
 * 签名刻意对齐 requestUrl 的子集（url/method/headers/throw），便于测试替换。
 */
export type ModelListFetcher = (req: {
	url: string;
	method: "GET";
	headers: Record<string, string>;
	throw: false;
}) => Promise<ModelListResponse>;

/** 默认拉取器：走 Obsidian requestUrl */
const defaultFetcher: ModelListFetcher = (req) => requestUrl(req);

/**
 * 拉取端点模型列表（GET {apiUrl}/models，apiKey 非空时带 Authorization 头）。
 * 仅成功拉取（HTTP 2xx）才按 apiUrl+apiKey 缓存 60 秒，过期或换端点重新拉取。
 * 失败（HTTP 非 2xx / 异常）不缓存，返回空数组（不影响手动输入）。
 *
 * @param fetcher 可选拉取器，生产默认走 Obsidian requestUrl，测试注入 mock。
 */
export async function fetchModelIds(
	apiUrl: string,
	apiKey: string,
	fetcher: ModelListFetcher = defaultFetcher,
): Promise<string[]> {
	const base = apiUrl.trim().replace(/\/+$/, "");
	const key = cacheKey(base, apiKey);
	if (!base) {
		return [];
	}
	// 命中且未过期才用缓存；过期则丢弃，继续重新拉取
	if (
		modelListCache &&
		modelListCache.key === key &&
		Date.now() < modelListCache.expiresAt
	) {
		return modelListCache.ids;
	}
	if (modelListCache && modelListCache.key === key) {
		// 同 key 但已过期，清掉避免误导
		modelListCache = null;
	}
	const url = `${base}/models`;
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	const t0 = Date.now();
	try {
		const resp = await fetcher({ url, method: "GET", headers, throw: false });
		if (resp.status < 200 || resp.status >= 300) {
			logWarn("settings", `拉取模型列表失败: HTTP ${resp.status}，耗时=${Date.now() - t0}ms`);
			return [];
		}
		const data = resp.json.data ?? [];
		const ids = data.map((m) => m.id).filter((x): x is string => !!x);
		// 仅成功才缓存，60 秒后过期
		modelListCache = { key, ids, expiresAt: Date.now() + MODEL_LIST_CACHE_TTL };
		logInfo("settings", `拉取模型列表成功: ${ids.length} 个模型，耗时=${Date.now() - t0}ms`);
		return ids;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logWarn("settings", `拉取模型列表失败: ${msg}，耗时=${Date.now() - t0}ms`);
		return [];
	}
}

/** 仅测试用：清空会话内模型列表缓存。生产代码不应调用。 */
export function __clearModelListCacheForTest(): void {
	modelListCache = null;
}

/**
 * 给「模型 id」输入框绑定端点返回的模型候选列表：输入时弹出下拉，支持模糊过滤与点选。
 * 交互逻辑与 FolderSuggest 一致（addSearch + AbstractInputSuggest），数据源是按需拉取的模型列表。
 *
 * 缓存分层：全局缓存（fetchModelIds 的 60 秒 TTL）作同端点去重加速层；
 * 每个 ModelSuggest 实例**持有自己的模型列表**（getSuggestions 首次调用时从全局缓存命中或网络拉取），
 * 这样切换分组/新增分组时旧实例随 DOM 销毁，新实例拿当前分组的列表，不会串到上一个分组的模型列表。
 * 点选后通过 onPick 回传模型 id，由调用方触发 onChange 保存。
 */
export class ModelSuggest extends AbstractInputSuggest<string> {
	/** 本实例的模型列表（从全局缓存命中或网络拉取） */
	private ids: string[] = [];
	/** 当前分组的 apiUrl（refresh 用，构造时不拉取，首次聚焦时才按此拉取） */
	private apiUrl: string;
	/** 当前分组的 apiKey */
	private apiKey: string;
	/** 是否已按当前 apiUrl+apiKey 拉取过（避免重复拉取；refresh 时重置） */
	private fetched = false;

	constructor(
		app: App,
		inputEl: HTMLInputElement | HTMLDivElement,
		apiUrl: string,
		apiKey: string,
		private readonly onPick: (modelId: string) => void,
	) {
		super(app, inputEl);
		this.limit = 50;
		this.apiUrl = apiUrl;
		this.apiKey = apiKey;
		// 惰性拉取：构造时不发请求。首次 getSuggestions 调用时（用户聚焦/输入触发）异步拉取，
		// Obsidian AbstractInputSuggest 原生支持 getSuggestions 返回 Promise，会 await 后再渲染下拉。
		// 这样首次聚焦即显示列表（不靠 focus 预拉取 fire-and-forget 回填 ids 的时序）。
	}

	/**
	 * 按最新 apiUrl+apiKey 重新取模型列表：重置 fetched 标志，下次 getSuggestions 触发时重新拉取。
	 * 用户编辑 API 地址 / API Key 后调用（建议去抖后调用，避免输入中间态逐字符触发）。
	 */
	refresh(apiUrl: string, apiKey: string): void {
		this.apiUrl = apiUrl;
		this.apiKey = apiKey;
		this.fetched = false;
		this.ids = [];
	}

	protected async getSuggestions(query: string): Promise<string[]> {
		if (!this.fetched) {
			// 首次：拉取（全局缓存命中则零请求）；拉取完填 ids，Obsidian 会 await 此 Promise 后渲染下拉
			this.fetched = true;
			this.ids = await fetchModelIds(this.apiUrl, this.apiKey);
		}
		const ids = this.ids;
		const value = query.trim();
		if (!value) {
			return ids.slice(0, this.limit);
		}
		const match = prepareFuzzySearch(value);
		return ids
			.filter((id) => match(id))
			.slice(0, this.limit);
	}

	renderSuggestion(id: string, element: HTMLElement): void {
		element.createDiv({ cls: "nihong-ai-model-suggest-id", text: id });
	}

	selectSuggestion(id: string, _evt: MouseEvent | KeyboardEvent): void {
		this.setValue(id);
		this.close();
		this.onPick(id);
	}
}
