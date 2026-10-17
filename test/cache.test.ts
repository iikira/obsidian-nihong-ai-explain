import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LRUTranslateCache, type CacheStorage } from "../src/translate/cache.ts";

// cache.ts 用 window.setTimeout/clearTimeout（浏览器 API），测试环境（Node）无 window，需注入。
// 仅 mock 定时器：让 scheduleFlush 立即同步执行 writeNow，便于断言。
let savedWindow: typeof globalThis.window | undefined;
beforeEach(() => {
	savedWindow = (globalThis as { window?: typeof globalThis.window }).window;
	(globalThis as { window: typeof globalThis.window }).window = {
		setTimeout: ((cb: () => void) => {
			cb();
			return 0 as number;
		}) as unknown as typeof window.setTimeout,
		clearTimeout: (() => {}) as unknown as typeof window.clearTimeout,
	} as typeof globalThis.window;
});
afterEach(() => {
	if (savedWindow === undefined) {
		delete (globalThis as { window?: typeof globalThis.window }).window;
	} else {
		(globalThis as { window: typeof globalThis.window }).window = savedWindow;
	}
});

/** 内存版 CacheStorage，模拟 App#saveLocalStorage/loadLocalStorage（已序列化为对象） */
function makeMemoryStorage(): { store: Map<string, unknown>; adapter: CacheStorage } {
	const store = new Map<string, unknown>();
	const adapter: CacheStorage = {
		load: <T>(key: string): T | null => (store.has(key) ? (store.get(key) as T) : null),
		save: (key: string, data: unknown | null) => {
			if (data === null) {
				store.delete(key);
			} else {
				store.set(key, data);
			}
		},
	};
	return { store, adapter };
}

test("LRUTranslateCache：get/set/size", () => {
	const cache = new LRUTranslateCache();
	assert.equal(cache.size(), 0);
	cache.set("k1", "v1");
	assert.equal(cache.size(), 1);
	assert.equal(cache.get("k1"), "v1");
	assert.equal(cache.get("missing"), undefined);
});

test("LRUTranslateCache：clear", () => {
	const cache = new LRUTranslateCache();
	cache.setStorage(makeMemoryStorage().adapter);
	cache.set("k1", "v1");
	cache.clear();
	assert.equal(cache.size(), 0);
	assert.equal(cache.get("k1"), undefined);
});

test("LRUTranslateCache：flush 写入存储", () => {
	const { store, adapter } = makeMemoryStorage();
	const cache = new LRUTranslateCache();
	cache.setStorage(adapter);
	cache.set("k1", "v1");
	cache.flush();
	const entries = store.get("nihong-ai-translate-cache") as [string, string][];
	assert.ok(entries);
	assert.deepEqual(entries, [["k1", "v1"]]);
});

test("LRUTranslateCache：load 从存储恢复", () => {
	const { adapter } = makeMemoryStorage();
	adapter.save("nihong-ai-translate-cache", [
		["k1", "v1"],
		["k2", "v2"],
	]);
	const cache = new LRUTranslateCache();
	cache.setStorage(adapter);
	cache.load();
	assert.equal(cache.size(), 2);
	assert.equal(cache.get("k1"), "v1");
	assert.equal(cache.get("k2"), "v2");
});

test("LRUTranslateCache：LRU 淘汰最旧（容量 1024）", () => {
	const cache = new LRUTranslateCache();
	// 填满到 1024
	for (let i = 0; i < 1024; i++) {
		cache.set(`k${i}`, `v${i}`);
	}
	assert.equal(cache.size(), 1024);
	// 再加一个，淘汰 k0（最旧）
	cache.set("k_new", "v_new");
	assert.equal(cache.size(), 1024);
	assert.equal(cache.get("k0"), undefined);
	assert.equal(cache.get("k_new"), "v_new");
});

test("LRUTranslateCache：get 提升 LRU 顺序", () => {
	const cache = new LRUTranslateCache();
	cache.set("k0", "v0");
	cache.set("k1", "v1");
	// 访问 k0，提升为最新
	cache.get("k0");
	// 加到满 + 1，应淘汰 k1（而非 k0）
	for (let i = 2; i < 1024; i++) {
		cache.set(`k${i}`, `v${i}`);
	}
	cache.set("k_new", "v_new");
	// k0 被访问过应保留，k1 最旧被淘汰
	assert.equal(cache.get("k0"), "v0");
	assert.equal(cache.get("k1"), undefined);
});

test("LRUTranslateCache：load 容错（非数组）", () => {
	const { adapter } = makeMemoryStorage();
	// 存入非数组对象，load 不应抛错且 size 为 0
	adapter.save("nihong-ai-translate-cache", { not: "an array" });
	const cache = new LRUTranslateCache();
	cache.setStorage(adapter);
	cache.load(); // 不抛
	assert.equal(cache.size(), 0);
});
