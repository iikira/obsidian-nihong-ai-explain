import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LRUTranslateCache } from "../src/translate/cache.ts";
import {
	installMockStorage,
	restoreMockStorage,
	getStore,
	clearStore,
} from "./helpers/mockStorage.ts";

beforeEach(() => {
	clearStore();
	installMockStorage();
});

afterEach(() => {
	restoreMockStorage();
});

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
	cache.set("k1", "v1");
	cache.clear();
	assert.equal(cache.size(), 0);
	assert.equal(cache.get("k1"), undefined);
});

test("LRUTranslateCache：flush 写入 localStorage", () => {
	const cache = new LRUTranslateCache();
	cache.set("k1", "v1");
	cache.flush();
	const raw = getStore().get("nihong-ai-translate-cache");
	assert.ok(raw);
	const entries = JSON.parse(raw!);
	assert.deepEqual(entries, [["k1", "v1"]]);
});

test("LRUTranslateCache：load 从 localStorage 恢复", () => {
	getStore().set(
		"nihong-ai-translate-cache",
		JSON.stringify([
			["k1", "v1"],
			["k2", "v2"],
		]),
	);
	const cache = new LRUTranslateCache();
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

test("LRUTranslateCache：load 容错（非法 JSON）", () => {
	getStore().set("nihong-ai-translate-cache", "not json");
	const cache = new LRUTranslateCache();
	cache.load(); // 不抛
	assert.equal(cache.size(), 0);
});
