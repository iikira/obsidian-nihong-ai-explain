// 测 PersistentTTSCache：内存 blobUrl + 字节持久层 + LRU 淘汰 + 重启重建。
// 注入 MemoryTTSCacheStorage（内存版适配器）绕过 IndexedDB，纯逻辑测试。
// 注意：URL.createObjectURL 在 Node 18+ 可用（返回 blob:nodedata:...），测试环境满足。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	PersistentTTSCache,
	MemoryTTSCacheStorage,
	type TTSCacheStorage,
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

// ====== LRU 顺序持久化测试 ======

test("重启后 LRU 顺序保持：set 顺序 k1→k2→k3，重启后 entries 顺序为 k3,k2,k1", async () => {
	await cache.set("k1", new ArrayBuffer(4));
	await cache.set("k2", new ArrayBuffer(4));
	await cache.set("k3", new ArrayBuffer(4));
	// 内存顺序：k1,k2,k3（最近使用 k3 在末尾）；entries() 逆序 → k3,k2,k1
	assert.deepEqual(cache.entries().map((e) => e.key), ["k3", "k2", "k1"]);
	// 模拟重启
	const cache2 = new PersistentTTSCache();
	cache2.setStorage(storage);
	await cache2.load();
	// 重启后顺序应一致：k3,k2,k1（最近使用在前）
	assert.deepEqual(cache2.entries().map((e) => e.key), ["k3", "k2", "k1"]);
});

test("get 提升后重启顺序更新：set k1→k2，get k1 提升后重启顺序为 k1,k2", async () => {
	await cache.set("k1", new ArrayBuffer(4));
	await cache.set("k2", new ArrayBuffer(4));
	cache.get("k1"); // k1 提升为最近使用
	// 内存 entries 顺序：k1,k2
	assert.deepEqual(cache.entries().map((e) => e.key), ["k1", "k2"]);
	const cache2 = new PersistentTTSCache();
	cache2.setStorage(storage);
	await cache2.load();
	// 重启后顺序应保持 k1,k2
	assert.deepEqual(cache2.entries().map((e) => e.key), ["k1", "k2"]);
});

test("set 持久化 order：覆盖同 key 时顺序提升到末尾", async () => {
	await cache.set("k1", new ArrayBuffer(4));
	await cache.set("k2", new ArrayBuffer(4));
	// 覆盖 k1，应提升到末尾：blobUrls = [k2,k1]
	await cache.set("k1", new ArrayBuffer(8));
	assert.deepEqual(cache.entries().map((e) => e.key), ["k1", "k2"]);
	// 持久层 order 是 blobUrls 逆序（最近使用在前）= [k1,k2]
	const order = await storage.getOrder();
	assert.deepEqual(order, ["k1", "k2"]);
});

test("load 时 order 缺失则退化为 getAll 顺序（兼容旧数据）", async () => {
	// 直接往持久层塞数据但不设 order（模拟旧版无 order 的库）
	await storage.put("a", new ArrayBuffer(4));
	await storage.put("b", new ArrayBuffer(4));
	// order 为空
	assert.deepEqual(await storage.getOrder(), []);
	const c = new PersistentTTSCache();
	c.setStorage(storage);
	await c.load();
	// 应按 getAll 的顺序加载（a,b），不抛错
	assert.equal(c.size(), 2);
	assert.ok(c.get("a"));
	assert.ok(c.get("b"));
});

test("clear 后持久层 order 也清空", async () => {
	await cache.set("k1", new ArrayBuffer(4));
	await cache.clear();
	assert.deepEqual(await storage.getOrder(), []);
});

test("load 后超容量淘汰：order 中超出部分从持久层删除 + order 截断", async () => {
	// 构造 130 条 + order
	for (let i = 0; i < 130; i++) {
		await cache.set(`k${i}`, new ArrayBuffer(4));
	}
	// order 应是 k129,...,k2（128 条），k0、k1 已被淘汰（内存 + 持久层）
	const orderLen = (await storage.getOrder()).length;
	assert.equal(orderLen, 128);
	assert.equal(storage.store.has("k0"), false);
	// 模拟重启，验证顺序与原 cache 一致
	const cache2 = new PersistentTTSCache();
	cache2.setStorage(storage);
	await cache2.load();
	assert.equal(cache2.size(), 128);
	const order2 = cache2.entries().map((e) => e.key);
	const order1 = cache.entries().map((e) => e.key);
	assert.deepEqual(order2, order1);
});

// ====== fire-and-forget 持久化测试（set 不阻塞播放）======

/**
 * 可注入慢/拒绝行为的 storage，验证 set() 不 await 持久层（播放不受 DB 阻塞）。
 * putHook/deleteHook 可被测试替换为自定义异步行为（延迟/拒绝/挂起）。
 */
class HookableStorage implements TTSCacheStorage {
	store = new Map<string, ArrayBuffer>();
	order: string[] = [];
	putHook: ((key: string, buffer: ArrayBuffer) => Promise<void>) | null = null;
	deleteHook: ((key: string) => Promise<void>) | null = null;
	putCalls = 0;
	deleteCalls = 0;
	async getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]> {
		return [...this.store.entries()].map(([key, buffer]) => ({ key, buffer }));
	}
	async getOrder(): Promise<string[]> {
		return [...this.order];
	}
	async setOrder(order: string[]): Promise<void> {
		this.order = [...order];
	}
	async put(key: string, buffer: ArrayBuffer): Promise<void> {
		this.putCalls++;
		if (this.putHook) {
			await this.putHook(key, buffer);
		}
		this.store.set(key, buffer);
	}
	async delete(key: string): Promise<void> {
		this.deleteCalls++;
		if (this.deleteHook) {
			await this.deleteHook(key);
		}
		this.store.delete(key);
	}
	async clear(): Promise<void> {
		this.store.clear();
		this.order = [];
	}
}

test("set 不阻塞播放：storage.put 慢时 set() 仍立即返回且内存层可用", async () => {
	const hs = new HookableStorage();
	let releasePut: () => void = () => {};
	// put 挂起直到测试释放（模拟慢/挂起的 IndexedDB）
	hs.putHook = () =>
		new Promise<void>((resolve) => {
			releasePut = resolve;
		});
	const c = new PersistentTTSCache();
	c.setStorage(hs);
	// set() 应立即返回（不等 put），内存层有 blobUrl 可播放
	const url = await c.set("k1", new ArrayBuffer(8));
	assert.ok(url.startsWith("blob:"));
	assert.equal(c.get("k1"), url); // 内存层命中
	assert.equal(hs.putCalls, 1); // put 已被调用（fire-and-forget 已发起）
	assert.equal(hs.store.has("k1"), false); // 但持久层还没写完（gate 未释放）
	// 释放 gate，让 put 完成
	releasePut();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(hs.store.has("k1"), true); // 释放后持久层写入完成
});

test("set 不阻塞播放：storage.put reject 时 set() 仍正常返回（仅记 warn）", async () => {
	const hs = new HookableStorage();
	hs.putHook = async () => {
		throw new Error("DB 写入失败");
	};
	const c = new PersistentTTSCache();
	c.setStorage(hs);
	// set() 不应抛错（fire-and-forget catch 掉持久层失败）
	const url = await c.set("k1", new ArrayBuffer(8));
	assert.ok(url.startsWith("blob:"));
	assert.equal(c.get("k1"), url); // 内存层仍可用，播放不受影响
	// 给 fire-and-forget 的 catch 一个微任务让它跑完
	await new Promise((r) => setTimeout(r, 0));
});

test("set 淘汰时持久层删除 fire-and-forget：内存层立即清，持久层异步删", async () => {
	const hs = new HookableStorage();
	let releaseDelete: () => void = () => {};
	hs.deleteHook = () =>
		new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
	const c = new PersistentTTSCache();
	c.setStorage(hs);
	// 填满 128 条
	for (let i = 0; i < 128; i++) {
		await c.set(`k${i}`, new ArrayBuffer(4));
	}
	// 加第 129 条触发淘汰 k0
	await c.set("k128", new ArrayBuffer(4));
	// 内存层 k0 应已立即淘汰
	assert.equal(c.get("k0"), null);
	assert.ok(c.get("k128")); // 新条目在
	// 持久层删除还在 gate 后面，未完成
	assert.equal(hs.deleteCalls, 1);
	releaseDelete();
	await new Promise((r) => setTimeout(r, 0));
});

// ====== load 超时测试 ======

test("load 超时不永久挂起：storage.getAll 不结算时超时后标记已加载", async () => {
	const hs = new HookableStorage();
	// getAll 永不结算（模拟 IndexedDB 被阻塞永久挂起）
	hs.getAll = () => new Promise(() => {});
	const c = new PersistentTTSCache();
	c.setStorage(hs);
	// loadWithTimeout 用 window.setTimeout（5s）；本测试环境无 window，桩一个最小 window，
	// 并把超时压成 ~50ms 加速测试（不等真实 5s）。
	const savedWindow = (globalThis as { window?: typeof globalThis.window }).window;
	(globalThis as { window: typeof globalThis.window }).window = {
		setTimeout: ((cb: (...a: unknown[]) => void, ms?: number) =>
			setTimeout(cb, Math.min(ms ?? 0, 50)) as unknown as number) as typeof window.setTimeout,
		clearTimeout: ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof window.clearTimeout,
	} as typeof globalThis.window;
	try {
		const start = Date.now();
		await c.load();
		const elapsed = Date.now() - start;
		assert.ok(c.isLoaded(), "超时后应标记已加载");
		assert.ok(elapsed < 1000, `应在 ~50ms 内超时而非真等 5s（实际 ${elapsed}ms）`);
		assert.equal(c.size(), 0); // 加载失败，内存为空
	} finally {
		if (savedWindow === undefined) {
			delete (globalThis as { window?: typeof globalThis.window }).window;
		} else {
			(globalThis as { window: typeof globalThis.window }).window = savedWindow;
		}
	}
});



