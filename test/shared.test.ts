import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildDisableThinking,
	CallLogger,
	extractUsage,
} from "../src/shared.ts";

test("buildDisableThinking：deepseek-v4 用 DeepSeek 风格", () => {
	assert.deepEqual(buildDisableThinking("deepseek-v4"), {
		thinking: { type: "disabled" },
	});
	assert.deepEqual(buildDisableThinking("my-deepseek-v4-pro"), {
		thinking: { type: "disabled" },
	});
});

test("buildDisableThinking：其他模型用 OpenAI 风格", () => {
	assert.deepEqual(buildDisableThinking("hy3-free"), {
		reasoning_effort: "none",
	});
	assert.deepEqual(buildDisableThinking("gpt-4o"), {
		reasoning_effort: "none",
	});
});

test("CallLogger：无 attempts 只输出 token 段", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (s: string) => logs.push(s);
	try {
		const logger = new CallLogger("test");
		logger.setUsage({
			prompt_tokens: 100,
			completion_tokens: 50,
			reasoning_tokens: 0,
			cached_tokens: 0,
		});
		logger.flush();
	} finally {
		console.log = orig;
	}
	assert.equal(logs.length, 1);
	assert.match(logs[0], /^\[test\] token: 输入=100 输出=50 思考=0 缓存命中=0$/);
});

test("CallLogger：缓存命中 > 0 显示百分比", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (s: string) => logs.push(s);
	try {
		const logger = new CallLogger("test");
		logger.setUsage({
			prompt_tokens: 200,
			completion_tokens: 10,
			reasoning_tokens: 0,
			cached_tokens: 100,
		});
		logger.recordAttempt({ ok: true, ms: 1500 });
		logger.flush();
	} finally {
		console.log = orig;
	}
	assert.equal(logs.length, 1);
	assert.match(logs[0], /缓存命中=100\(50%\)/);
	assert.match(logs[0], /1 次调用 · 成功 1 · 失败 0 · 累计 1500ms · 终态 成功/);
});

test("CallLogger：失败终态与失败计数", () => {
	const logs: string[] = [];
	const orig = console.log;
	console.log = (s: string) => logs.push(s);
	try {
		const logger = new CallLogger("test");
		logger.setUsage({
			prompt_tokens: 0,
			completion_tokens: 0,
			reasoning_tokens: 0,
			cached_tokens: 0,
		});
		logger.recordAttempt({ ok: false, ms: 100 });
		logger.recordAttempt({ ok: false, ms: 200 });
		logger.flush();
	} finally {
		console.log = orig;
	}
	assert.equal(logs.length, 1);
	assert.match(logs[0], /2 次调用 · 成功 0 · 失败 2 · 累计 300ms · 终态 失败/);
	// 缓存命中=0 不显示百分比
	assert.match(logs[0], /缓存命中=0(?![(])/);
});

test("extractUsage：无 usage 返回 null", () => {
	assert.equal(extractUsage({}), null);
	assert.equal(extractUsage({ choices: [] }), null);
});

test("extractUsage：OpenAI 风格（prompt_tokens_details.cached_tokens）", () => {
	assert.deepEqual(
		extractUsage({
			usage: {
				prompt_tokens: 200,
				completion_tokens: 10,
				completion_tokens_details: { reasoning_tokens: 5 },
				prompt_tokens_details: { cached_tokens: 100 },
			},
		}),
		{
			prompt_tokens: 200,
			completion_tokens: 10,
			reasoning_tokens: 5,
			cached_tokens: 100,
		},
	);
});

test("extractUsage：DeepSeek 风格（prompt_cache_hit_tokens）", () => {
	assert.deepEqual(
		extractUsage({
			usage: {
				prompt_tokens: 500,
				completion_tokens: 20,
				prompt_cache_hit_tokens: 300,
			},
		}),
		{
			prompt_tokens: 500,
			completion_tokens: 20,
			reasoning_tokens: 0,
			cached_tokens: 300,
		},
	);
});

test("extractUsage：缺 prompt_tokens 时用 total - completion 兜底", () => {
	assert.deepEqual(
		extractUsage({
			usage: {
				completion_tokens: 22,
				total_tokens: 100,
			},
		}),
		{
			prompt_tokens: 78, // 100 - 22
			completion_tokens: 22,
			reasoning_tokens: 0,
			cached_tokens: 0,
		},
	);
});

test("extractUsage：total == completion 时 prompt 兜底为 0", () => {
	// 如某些端点只返回 {completion_tokens, total_tokens} 且 total == completion
	assert.deepEqual(
		extractUsage({
			usage: { completion_tokens: 22, total_tokens: 22 },
		}),
		{
			prompt_tokens: 0,
			completion_tokens: 22,
			reasoning_tokens: 0,
			cached_tokens: 0,
		},
	);
});

test("extractUsage：input_tokens/output_tokens 别名兼容", () => {
	assert.deepEqual(
		extractUsage({
			usage: { input_tokens: 50, output_tokens: 8 },
		}),
		{
			prompt_tokens: 50,
			completion_tokens: 8,
			reasoning_tokens: 0,
			cached_tokens: 0,
		},
	);
});

