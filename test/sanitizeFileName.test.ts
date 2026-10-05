import { test } from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeFileName,
	hasForbiddenFileNameChar,
	MAX_WORD_LEN,
} from "../src/utils/index.ts";

test("sanitizeFileName：保留普通文字", () => {
	assert.equal(sanitizeFileName("病む"), "病む");
	assert.equal(sanitizeFileName("hello"), "hello");
});

test("sanitizeFileName：去除 Windows 非法字符", () => {
	assert.equal(sanitizeFileName("a/b:c*d"), "abcd");
	// 去掉 " < > | ? \ 后剩 a b c e f g h
	assert.equal(sanitizeFileName('a"b<c>e|f?g\\h'), "abcefgh");
});

test("sanitizeFileName：空白折叠为下划线", () => {
	assert.equal(sanitizeFileName("a b\tc"), "a_b_c");
	assert.equal(sanitizeFileName("hello world"), "hello_world");
});

test("sanitizeFileName：空字符串兜底为 untitled", () => {
	assert.equal(sanitizeFileName(""), "untitled");
});

test("sanitizeFileName：空白折叠为下划线", () => {
	assert.equal(sanitizeFileName("   "), "_"); // 空白折叠为下划线
	assert.equal(sanitizeFileName("a b"), "a_b");
	assert.equal(sanitizeFileName("　"), "_"); // 全角空格 → 下划线
});

test("sanitizeFileName：限长 MAX_WORD_LEN", () => {
	const long = "a".repeat(MAX_WORD_LEN + 50);
	const result = sanitizeFileName(long);
	assert.equal(result.length, MAX_WORD_LEN);
});

test("sanitizeFileName：去掉非法字符后再限长", () => {
	const long = "a".repeat(MAX_WORD_LEN + 10) + "/b".repeat(20);
	const result = sanitizeFileName(long);
	assert.equal(result.length, MAX_WORD_LEN);
	assert.ok(!result.includes("/"));
});

test("hasForbiddenFileNameChar：含非法字符返回 true", () => {
	assert.equal(hasForbiddenFileNameChar("a/b"), true);
	assert.equal(hasForbiddenFileNameChar("a:b"), true);
	assert.equal(hasForbiddenFileNameChar("a*b"), true);
	assert.equal(hasForbiddenFileNameChar('a"b'), true);
	assert.equal(hasForbiddenFileNameChar("a<b"), true);
	assert.equal(hasForbiddenFileNameChar("a>b"), true);
	assert.equal(hasForbiddenFileNameChar("a|b"), true);
	assert.equal(hasForbiddenFileNameChar("a?b"), true);
	assert.equal(hasForbiddenFileNameChar("a\\b"), true);
});

test("hasForbiddenFileNameChar：不含非法字符返回 false", () => {
	assert.equal(hasForbiddenFileNameChar("病む"), false);
	assert.equal(hasForbiddenFileNameChar("hello world"), false);
	assert.equal(hasForbiddenFileNameChar("あいうえお"), false);
	assert.equal(hasForbiddenFileNameChar(""), false);
});
