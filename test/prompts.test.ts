// 测 prompts.ts：TRANSLATE_SYSTEM_PROMPT(target) 纯函数（target 插值进模板）。
// EXPLAIN_SYSTEM_PROMPT / GRAMMAR_SYSTEM_PROMPT 是常量字符串，测意义不大，仅验证非空。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	TRANSLATE_SYSTEM_PROMPT,
	EXPLAIN_SYSTEM_PROMPT,
	GRAMMAR_SYSTEM_PROMPT,
} from "../src/prompts.ts";

test("TRANSLATE_SYSTEM_PROMPT：target 插值进模板", () => {
	const p = TRANSLATE_SYSTEM_PROMPT("中文");
	assert.ok(p.includes("中文"), "应含 target");
	assert.ok(p.includes("翻译为中文"), "应含「翻译为中文」");
});

test("TRANSLATE_SYSTEM_PROMPT：不同 target 生成不同字符串", () => {
	const zh = TRANSLATE_SYSTEM_PROMPT("中文");
	const en = TRANSLATE_SYSTEM_PROMPT("English");
	assert.notEqual(zh, en);
	assert.ok(zh.includes("中文"));
	assert.ok(en.includes("English"));
});

test("TRANSLATE_SYSTEM_PROMPT：要求只输出译文（无解释/引号/寒暄）", () => {
	const p = TRANSLATE_SYSTEM_PROMPT("中文");
	assert.ok(p.includes("只输出译文"), "应约束只输出译文");
	assert.ok(p.includes("换行"), "应保留换行段落结构要求");
});

test("TRANSLATE_SYSTEM_PROMPT：空 target 也能生成（不抛错）", () => {
	const p = TRANSLATE_SYSTEM_PROMPT("");
	assert.equal(typeof p, "string");
	assert.ok(p.includes("翻译为"));
});

test("EXPLAIN_SYSTEM_PROMPT / GRAMMAR_SYSTEM_PROMPT：非空字符串常量", () => {
	assert.ok(typeof EXPLAIN_SYSTEM_PROMPT === "string" && EXPLAIN_SYSTEM_PROMPT.length > 0);
	assert.ok(typeof GRAMMAR_SYSTEM_PROMPT === "string" && GRAMMAR_SYSTEM_PROMPT.length > 0);
	assert.notEqual(EXPLAIN_SYSTEM_PROMPT, GRAMMAR_SYSTEM_PROMPT);
});
