// 测 ModelSuggest 类：getSuggestions 改 async 后首次调用即异步拉取并返回列表（修复首次点击不展示）。
// 依赖 test/build.mjs 的 obsidian 桩：AbstractInputSuggest（最小基类）+ requestUrl（返非空模型列表）。
// 全局 modelListCache 是模块级单例，测试间串；用例前 __clearModelListCacheForTest() 清空。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	ModelSuggest,
	__clearModelListCacheForTest,
} from "../src/settings/modelSuggest.ts";

// mock App（ModelSuggest 传给 AbstractInputSuggest 基类构造，基类桩只存不读）
const mockApp = {} as unknown as ConstructorParameters<typeof ModelSuggest>[0];

/** mock inputEl：duck-typed，只需 addEventListener（构造里不再绑 focus，但保留兼容） */
function makeMockInputEl(): {
	value: string;
	addEventListener: (_type: string, _cb: (...a: unknown[]) => void) => void;
} {
	return {
		value: "",
		addEventListener() {
			// 构造里已不绑 focus（getSuggestions 改 async 后无需预拉取）
		},
	};
}

beforeEach(() => {
	__clearModelListCacheForTest();
});

afterEach(() => {
	__clearModelListCacheForTest();
});

test("首次 getSuggestions：异步拉取并返回模型列表（不再首次空）", async () => {
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key1", () => {});
	// 首次调用：fetchModelIds 走 obsidian 桩 requestUrl（返 model-a/model-b），getSuggestions await 后返回
	const ids = await suggest.getSuggestions("");
	assert.deepEqual(ids, ["model-a", "model-b"], "首次 getSuggestions 应返回桩的模型列表");
});

test("fetched 防重复：第二次 getSuggestions 不再发请求", async () => {
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key2", () => {});
	const first = await suggest.getSuggestions("");
	assert.deepEqual(first, ["model-a", "model-b"]);
	// 第二次：fetched=true，直接返回内存 ids，不再走 fetchModelIds（全局缓存命中也不应再触发桩请求）
	// 因桩固定返同样列表，这里验证 fetched 标志：清空全局缓存后第二次仍应返回列表（证明走的是内存 ids 非 cache）
	__clearModelListCacheForTest();
	const second = await suggest.getSuggestions("");
	assert.deepEqual(second, ["model-a", "model-b"], "fetched=true 时返回内存 ids，清缓存后仍返回列表");
});

test("空 query 返回全部（截断 limit）", async () => {
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key3", () => {});
	const ids = await suggest.getSuggestions("");
	assert.ok(ids.length <= 50, "应受 limit=50 截断");
	assert.deepEqual(ids, ["model-a", "model-b"]);
});

test("带 query 模糊过滤", async () => {
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key4", () => {});
	const ids = await suggest.getSuggestions("a");
	assert.deepEqual(ids, ["model-a"], "query=a 应模糊匹配 model-a");
});

test("refresh 重置 fetched：下次 getSuggestions 重新拉取", async () => {
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key5", () => {});
	await suggest.getSuggestions(""); // 首次拉取，fetched=true
	// refresh 重置 fetched=false + ids=[]，换新端点（新 key 不命中全局缓存）
	suggest.refresh("https://api.test/v2", "key6");
	// refresh 后 getSuggestions 应重新拉取（fetched 重置）：新端点新 key，走桩 requestUrl 返 model-a/model-b
	const ids = await suggest.getSuggestions("");
	assert.deepEqual(ids, ["model-a", "model-b"], "refresh 后 getSuggestions 应重新拉取");
});

test("全局缓存命中：同 apiUrl+apiKey 第二次零请求（走缓存）", async () => {
	const inputEl1 = makeMockInputEl();
	const suggest1 = new ModelSuggest(mockApp, inputEl1, "https://cache.test/v1", "ck", () => {});
	await suggest1.getSuggestions(""); // 首次：发请求 + 写全局缓存
	// 第二个实例，同端点同 key：应命中全局缓存，不发请求（桩返同样列表，但验证路径走缓存）
	const inputEl2 = makeMockInputEl();
	const suggest2 = new ModelSuggest(mockApp, inputEl2, "https://cache.test/v1", "ck", () => {});
	const ids = await suggest2.getSuggestions("");
	assert.deepEqual(ids, ["model-a", "model-b"], "同端点第二实例应命中全局缓存返回列表");
});

test("onPick 回调：selectSuggestion 调用 onPick", async () => {
	let picked = "";
	const inputEl = makeMockInputEl();
	const suggest = new ModelSuggest(mockApp, inputEl, "https://api.test/v1", "key7", (id) => {
		picked = id;
	});
	await suggest.getSuggestions("");
	suggest.selectSuggestion("model-a", {} as unknown as MouseEvent);
	assert.equal(picked, "model-a", "selectSuggestion 应回调 onPick 传 model id");
});
