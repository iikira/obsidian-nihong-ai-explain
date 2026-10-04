import { test } from "node:test";
import assert from "node:assert/strict";
import { Deinflector } from "../src/dictionary/deinflector.ts";

test("Deinflector：辞书形原样返回（含原词）", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べる");
	// 至少含原词
	assert.ok(results.some((r) => r.term === "食べる"));
});

test("Deinflector：ます形 → 辞书形", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べます");
	assert.ok(results.some((r) => r.term === "食べる"));
});

test("Deinflector：た形 → 辞书形", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べた");
	assert.ok(results.some((r) => r.term === "食べる"));
});

test("Deinflector：て形 → 辞书形", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べて");
	assert.ok(results.some((r) => r.term === "食べる"));
});

test("Deinflector：ない形 → 辞书形", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べない");
	assert.ok(results.some((r) => r.term === "食べる"));
});

test("Deinflector：变形候选带变形原因链", () => {
	const d = new Deinflector();
	const results = d.deinflect("食べません");
	const hit = results.find((r) => r.term === "食べる");
	// 至少有一条候选带变形原因
	assert.ok(results.some((r) => r.reasons.length > 0));
});

test("Deinflector：五段动词变形还原", () => {
	const d = new Deinflector();
	// 書きます → 書く（五段）
	const results = d.deinflect("書きます");
	assert.ok(results.some((r) => r.term === "書く"));
});

test("Deinflector：getRuleFlags 返回位掩码", () => {
	const d = new Deinflector();
	const flags = d.getRuleFlags(["v5"]);
	assert.ok(typeof flags === "number");
	assert.ok(flags > 0);
	// 未知规则不影响掩码
	assert.equal(d.getRuleFlags(["unknown_rule"]), 0);
	// 多规则叠加
	const v5 = d.getRuleFlags(["v5"]);
	const v1 = d.getRuleFlags(["v1"]);
	assert.equal(d.getRuleFlags(["v5", "v1"]), v5 | v1);
});
