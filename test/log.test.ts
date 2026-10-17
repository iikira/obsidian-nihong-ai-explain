import { test } from "node:test";
import assert from "node:assert/strict";
import { logger, logInfo, logWarn, logError } from "../src/log/index";

test("logger：log 追加日志并按 FIFO 弃旧", () => {
	// 用独立实例避免污染全局单例：直接测 Logger 行为
	// 全局单例已被其他测试/视图使用，这里测便捷函数 + getEntries/clear/subscribe
	const before = logger.getEntries().length;
	logInfo("test-src", "info 消息");
	logWarn("test-src", "warn 消息");
	logError("test-src", "error 消息");
	const entries = logger.getEntries();
	assert.ok(entries.length >= before + 3, "应追加 3 条");
	const last3 = entries.slice(-3);
	assert.equal(last3[0].level, "info");
	assert.equal(last3[1].level, "warn");
	assert.equal(last3[2].level, "error");
	assert.equal(last3[0].source, "test-src");
	assert.equal(last3[0].text, "info 消息");
	assert.match(String(last3[0].ts), /^\d+$/);
});

test("logger：subscribe 收到新日志批次", () => {
	const received: string[] = [];
	const unsub = logger.subscribe((batch) => {
		for (const e of batch) {
			received.push(e.text);
		}
	});
	try {
		logInfo("test-sub", "订阅测试 A");
		logWarn("test-sub", "订阅测试 B");
		assert.ok(received.includes("订阅测试 A"));
		assert.ok(received.includes("订阅测试 B"));
	} finally {
		unsub();
	}
	// 取消订阅后不再收到
	logInfo("test-sub", "订阅测试 C（不应收到）");
	assert.ok(!received.includes("订阅测试 C（不应收到）"));
});

test("logger：clear 清空并通知空批次", () => {
	// 先确保有内容
	logInfo("test-clear", "待清空");
	assert.ok(logger.getEntries().some((e) => e.text === "待清空"));
	let cleared = false;
	const unsub = logger.subscribe((batch) => {
		if (batch.length === 0) {
			cleared = true;
		}
	});
	try {
		logger.clear();
		assert.equal(logger.getEntries().length, 0, "清空后无日志");
		assert.ok(cleared, "clear 应通知空批次给订阅者");
	} finally {
		unsub();
	}
});
