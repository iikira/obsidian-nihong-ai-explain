import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	fetchModelIds,
	__clearModelListCacheForTest,
	type ModelListFetcher,
} from "../src/settings/modelSuggest.ts";

// modelSuggest.ts 的缓存是模块级单条（modelListCache），测试间会串；每个用例前清空。
// requestUrl（Obsidian API）在测试环境为 undefined，故 fetchModelIds 走注入的 mock fetcher。
// Date.now() 控制 TTL 过期：用 fakeNow 覆盖 Date.now，便于断言 60 秒边界。

/** 造一个返回固定 ids 的 fetcher，同时记录调用次数与最后一次请求参数 */
function makeFetcher(
	ids: string[],
	status = 200,
): {
	fetcher: ModelListFetcher;
	calls: { n: number };
	lastReq: { value: { url: string; headers: Record<string, string> } | null };
} {
	const calls = { n: 0 };
	// 用对象容器而非 let 变量，保证返回后外部能读到 fetcher 内部写入的最新值
	const lastReq: { value: { url: string; headers: Record<string, string> } | null } = {
		value: null,
	};
	const fetcher: ModelListFetcher = async (req) => {
		calls.n++;
		lastReq.value = req;
		return { status, json: { data: ids.map((id) => ({ id })) } };
	};
	return { fetcher, calls, lastReq };
}

/** 返回 HTTP 非 2xx 的 fetcher，带计数 */
function makeErrorStatusFetcher(
	status: number,
): {
	fetcher: ModelListFetcher;
	calls: { n: number };
} {
	const calls = { n: 0 };
	const fetcher: ModelListFetcher = async () => {
		calls.n++;
		return { status, json: { data: [] } };
	};
	return { fetcher, calls };
}

/** 抛错的 fetcher，模拟网络异常，带计数 */
function makeThrowingFetcher(
	err: Error,
): {
	fetcher: ModelListFetcher;
	calls: { n: number };
} {
	const calls = { n: 0 };
	const fetcher: ModelListFetcher = async () => {
		calls.n++;
		throw err;
	};
	return { fetcher, calls };
}

let savedDateNow: () => number;
let fakeNow: number;
beforeEach(() => {
	__clearModelListCacheForTest();
	savedDateNow = Date.now;
	fakeNow = 1_700_000_000_000; // 固定起点
	Date.now = () => fakeNow;
});
afterEach(() => {
	Date.now = savedDateNow;
	__clearModelListCacheForTest();
});

test("fetchModelIds：首次拉取返回 ids 并调用 fetcher 一次", async () => {
	const { fetcher, calls } = makeFetcher(["a", "b"]);
	const ids = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.deepEqual(ids, ["a", "b"]);
	assert.equal(calls.n, 1);
});

test("fetchModelIds：同 apiUrl+apiKey 第二次命中缓存，不再调 fetcher", async () => {
	const { fetcher, calls } = makeFetcher(["a", "b"]);
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	const ids = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.deepEqual(ids, ["a", "b"]);
	assert.equal(calls.n, 1, "命中缓存不应再次请求");
});

test("fetchModelIds：换 apiUrl 视为不同端点，重新拉取", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	await fetchModelIds("https://api.y.com/v1", "", fetcher);
	assert.equal(calls.n, 2, "换 apiUrl 应重新拉取");
});

test("fetchModelIds：换 apiKey 视为不同端点，重新拉取", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "key1", fetcher);
	await fetchModelIds("https://api.x.com/v1", "key2", fetcher);
	assert.equal(calls.n, 2, "换 apiKey 应重新拉取");
});

test("fetchModelIds：apiKey 非空时请求带 Authorization 头", async () => {
	const { fetcher, lastReq } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "secret-key", fetcher);
	assert.equal(lastReq.value?.headers["Authorization"], "Bearer secret-key");
});

test("fetchModelIds：apiKey 为空时不带 Authorization 头", async () => {
	const { fetcher, lastReq } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.equal(lastReq.value?.headers["Authorization"], undefined);
});

test("fetchModelIds：apiUrl 末尾斜杠被规范化，与无斜杠同 key 命中缓存", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1/", "", fetcher);
	const ids = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.deepEqual(ids, ["a"]);
	assert.equal(calls.n, 1, "末尾斜杠不应导致 key 不一致而重复请求");
});

test("fetchModelIds：空 apiUrl 返回空数组且不调 fetcher", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	const ids = await fetchModelIds("   ", "", fetcher);
	assert.deepEqual(ids, []);
	assert.equal(calls.n, 0, "空 apiUrl 不应请求");
});

test("fetchModelIds：HTTP 非 2xx 返回空且不缓存，下次仍重新请求", async () => {
	const { fetcher: f1, calls: c1 } = makeErrorStatusFetcher(401);
	const ids1 = await fetchModelIds("https://api.x.com/v1", "k", f1);
	assert.deepEqual(ids1, []);
	assert.equal(c1.n, 1);
	// HTTP 错误不缓存，下次同 key 仍重新请求
	const ids2 = await fetchModelIds("https://api.x.com/v1", "k", f1);
	assert.deepEqual(ids2, []);
	assert.equal(c1.n, 2, "HTTP 401 不缓存，两次都应请求");

	// HTTP 500 同样不缓存
	const { fetcher: f2, calls: c2 } = makeErrorStatusFetcher(500);
	await fetchModelIds("https://api.x.com/v1", "k2", f2);
	await fetchModelIds("https://api.x.com/v1", "k2", f2);
	assert.equal(c2.n, 2, "HTTP 500 不缓存，两次都应请求");
});

test("fetchModelIds：fetcher 抛异常返回空且不缓存", async () => {
	const { fetcher, calls } = makeThrowingFetcher(new Error("network down"));
	const ids1 = await fetchModelIds("https://api.x.com/v1", "k", fetcher);
	assert.deepEqual(ids1, []);
	assert.equal(calls.n, 1);
	// 异常不缓存，再调一次仍会尝试请求
	const ids2 = await fetchModelIds("https://api.x.com/v1", "k", fetcher);
	assert.deepEqual(ids2, []);
	assert.equal(calls.n, 2, "异常不缓存，两次都应请求");
});

test("fetchModelIds：缓存 60 秒内命中，超过 60 秒过期重新拉取", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	// 推进 59 秒：仍命中
	fakeNow += 59_000;
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.equal(calls.n, 1, "59 秒内应命中缓存");
	// 推进到 60 秒整：边界过期，重新拉取
	fakeNow += 1_000;
	const ids = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.equal(calls.n, 2, "满 60 秒应过期重新拉取");
	assert.deepEqual(ids, ["a"]);
});

test("fetchModelIds：过期后重新拉取成功会刷新缓存与过期时间", async () => {
	const { fetcher, calls } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	// 过期
	fakeNow += 60_001;
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.equal(calls.n, 2);
	// 刷新后又在 60 秒内，再次命中
	fakeNow += 10_000;
	await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.equal(calls.n, 2, "刷新缓存后 60 秒内应命中");
});

test("fetchModelIds：成功拉取但 ids 为空，仍缓存（空列表也是有效结果）", async () => {
	const { fetcher, calls } = makeFetcher([]);
	const ids1 = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.deepEqual(ids1, []);
	// 空列表成功结果应被缓存，第二次不请求
	const ids2 = await fetchModelIds("https://api.x.com/v1", "", fetcher);
	assert.deepEqual(ids2, []);
	assert.equal(calls.n, 1, "空列表成功结果应缓存");
});

test("fetchModelIds：请求 URL 由 apiUrl 去末尾斜杠 + /models 拼接", async () => {
	const { fetcher, lastReq } = makeFetcher(["a"]);
	await fetchModelIds("https://api.x.com/v1///", "", fetcher);
	assert.equal(lastReq.value?.url, "https://api.x.com/v1/models");
	assert.equal(lastReq.value?.method, "GET");
});
