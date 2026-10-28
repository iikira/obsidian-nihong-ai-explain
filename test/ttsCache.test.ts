// 测 PersistentTTSCache：内存 blobUrl + 字节持久层 + LRU 淘汰 + 重启重建。
// 注入 MemoryTTSCacheStorage（内存版适配器）绕过 IndexedDB，纯逻辑测试。
// 注意：URL.createObjectURL 在 Node 18+ 可用（返回 blob:nodedata:...），测试环境满足。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	PersistentTTSCache,
	MemoryTTSCacheStorage,
} from "../src/tts/cache.ts";

let cache: PersistentTTSCache;
let storage: MemoryTTSCacheStorage;

beforeEach(() => {
	storage = new MemoryTTSCacheStorage();
	cache = new PersistentTTSCache();
	cache.setStorage(storage);
});

afterEach(async () => {
	await cache.clear();
});

test("set 后 get 命中，返回有效 blobUrl", async () => {
	const url = await cache.set("k1", new ArrayBuffer(8));
	assert.equal(typeof url, "string");
	assert.ok(url.startsWith("blob:"));
	assert.equal(cache.get("k1"), url);
});

test("未命中 get 返回 null", () => {
	assert.equal(cache.get("missing"), null);
});

test("未加载时 get 返回 null（load 前不命中）", () => {
	// 新 cache 未 load，内存空
	assert.equal(cache.get("k1"), null);
});

test("持久化 + 重启重建：set → clear 内存 → load 恢复命中", async () => {
	const url1 = await cache.set("k1", new ArrayBuffer(8));
	assert.ok(url1);
	// 模拟重启：新 cache + 同一 storage（持久层未清）
	const cache2 = new PersistentTTSCache();
	cache2.setStorage(storage);
	assert.equal(cache2.get("k1"), null); // load 前不命中
	await cache2.load();
	const url2 = cache2.get("k1");
	assert.ok(url2); // load 后命中
	assert.notEqual(url1, url2); // blobUrl 重建，与旧的不同
});

test("LRU：get 提升 key 到最近使用，超容量淘汰最旧（两层同步）", async () => {
	// 容量 128，构造 130 条，验证第 1、2 条被淘汰（持久层也删）
	const keys: string[] = [];
	for (let i = 0; i < 130; i++) {
		const k = `k${i}`;
		await cache.set(k, new ArrayBuffer(4));
		keys.push(k);
	}
	assert.equal(cache.size(), 128);
	// 最旧 k0、k1 应被淘汰
	assert.equal(cache.get("k0"), null);
	assert.equal(cache.get("k1"), null);
	assert.ok(cache.get("k2")); // k2 仍在
	// 持久层也同步删除
	assert.equal(storage.store.has("k0"), false);
	assert.equal(storage.store.has("k2"), true);
});

test("覆盖同 key：revoke 旧 blobUrl，新 blobUrl 生效", async () => {
	const url1 = await cache.set("k1", new ArrayBuffer(8));
	const url2 = await cache.set("k1", new ArrayBuffer(16));
	assert.notEqual(url1, url2);
	assert.equal(cache.get("k1"), url2);
	// 持久层只保留最新字节
	assert.equal(storage.store.get("k1")?.byteLength, 16);
});

test("clear：内存清空 + 持久层清空", async () => {
	await cache.set("k1", new ArrayBuffer(8));
	await cache.set("k2", new ArrayBuffer(8));
	await cache.clear();
	assert.equal(cache.size(), 0);
	assert.equal(cache.get("k1"), null);
	assert.equal(storage.store.size, 0);
});

test("get 命中后 LRU 提升：再 set 到容量边界时该 key 不被淘汰", async () => {
	// 填满 128 条
	for (let i = 0; i < 128; i++) {
		await cache.set(`k${i}`, new ArrayBuffer(4));
	}
	// 访问 k0（最旧）提升为最近使用
	cache.get("k0");
	// 再加一条触发淘汰
	await cache.set("k128", new ArrayBuffer(4));
	// k0 因被访问过应保留，k1（新最旧）应被淘汰
	assert.ok(cache.get("k0"));
	assert.equal(cache.get("k1"), null);
});

test("load 加载失败不阻塞：标记已加载，内存为空", async () => {
	// 用一个会抛错的 storage
	const badStorage = new MemoryTTSCacheStorage();
	badStorage.getAll = async () => {
		throw new Error("读失败");
	};
	const c = new PersistentTTSCache();
	c.setStorage(badStorage);
	await c.load();
	assert.equal(c.isLoaded(), true);
	assert.equal(c.get("any"), null);
});
