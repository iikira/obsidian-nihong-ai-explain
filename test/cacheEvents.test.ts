// 测缓存变更事件总线（cacheEvents.ts）：纯发布订阅，零依赖。
// 注意：listeners 是模块级 Set 单例，测试间共享。每个测试在 test 内 subscribe + 末尾 unsubscribe，
// 保证不跨测试残留订阅。
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitCacheChange, subscribeCacheChange, type CacheKind } from "../src/cacheEvents.ts";

test("subscribe 后 emit，回调被调用并收到 kind", () => {
	const received: CacheKind[] = [];
	const unsub = subscribeCacheChange((kind) => received.push(kind));
	emitCacheChange("translate");
	assert.deepEqual(received, ["translate"]);
	emitCacheChange("tts");
	assert.deepEqual(received, ["translate", "tts"]);
	unsub();
});

test("unsubscribe 后 emit，回调不再被调用", () => {
	let calls = 0;
	const unsub = subscribeCacheChange(() => calls++);
	emitCacheChange("translate");
	assert.equal(calls, 1);
	unsub();
	emitCacheChange("tts");
	assert.equal(calls, 1, "取消订阅后回调不应再被调用");
});

test("多订阅者都被通知", () => {
	let a = 0;
	let b = 0;
	const ua = subscribeCacheChange(() => a++);
	const ub = subscribeCacheChange(() => b++);
	emitCacheChange("translate");
	assert.equal(a, 1);
	assert.equal(b, 1);
	emitCacheChange("tts");
	assert.equal(a, 2);
	assert.equal(b, 2);
	ua();
	ub();
});

test("同一回调重复 subscribe 只注册一次", () => {
	let calls = 0;
	const cb = (): void => {
		calls++;
	};
	const u1 = subscribeCacheChange(cb);
	const u2 = subscribeCacheChange(cb);
	emitCacheChange("translate");
	assert.equal(calls, 1, "同一函数引用只注册一次");
	u1();
	u2();
});

test("unsubscribe 是幂等的（取消多次不报错）", () => {
	const unsub = subscribeCacheChange(() => {});
	unsub();
	assert.doesNotThrow(() => unsub());
});

test("emitCacheChange 无订阅者时不报错", () => {
	// 无订阅者直接 emit（listeners 为空或只有别人的），不应抛错
	assert.doesNotThrow(() => emitCacheChange("translate"));
});
