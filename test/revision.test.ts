import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRevisions } from "../src/dictionary/revision.ts";

test("compareRevisions：相等返回 0", () => {
	assert.equal(compareRevisions("2024-03-15", "2024-03-15"), 0);
	assert.equal(compareRevisions("1.2.3", "1.2.3"), 0);
});

test("compareRevisions：ISO 日期按数值比较", () => {
	assert.equal(compareRevisions("2024-03-15", "2024-03-14"), 1);
	assert.equal(compareRevisions("2024-03-14", "2024-03-15"), -1);
	assert.equal(compareRevisions("2024-12-01", "2024-03-15"), 1);
	assert.equal(compareRevisions("2023-12-01", "2024-03-15"), -1);
});

test("compareRevisions：不补零的日期段也按数值比较", () => {
	assert.equal(compareRevisions("2024-3-5", "2024-03-15"), -1);
	assert.equal(compareRevisions("2024-3-5", "2024-3-4"), 1);
});

test("compareRevisions：语义版本号按段比较", () => {
	assert.equal(compareRevisions("1.10.0", "1.9.0"), 1);
	assert.equal(compareRevisions("1.2.1", "1.2.0"), 1);
	assert.equal(compareRevisions("1.2.0", "1.2.1"), -1);
	assert.equal(compareRevisions("2.0.0", "1.99.99"), 1);
});

test("compareRevisions：数字段全等但长度不同，段多者为新", () => {
	assert.equal(compareRevisions("1.2", "1.2.1"), -1);
	assert.equal(compareRevisions("1.2.1", "1.2"), 1);
});

test("compareRevisions：无法解析数字时退化为字典序", () => {
	assert.equal(compareRevisions("abc", "abd"), -1);
	assert.equal(compareRevisions("zzz", "aaa"), 1);
});
