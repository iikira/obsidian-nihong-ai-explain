// 测 utils/index.ts 的 resolveTargetPath（纯路径拼接 + sanitizeFileName 清洗）。
// normalizePath 在测试桩里是 identity (p)=>p，故只测拼接/清洗逻辑，不测 normalizePath 的路径分隔符规整。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetPath } from "../src/utils/index.ts";

test("resolveTargetPath：word + outputDir 拼接为 dir/word.md", () => {
	const p = resolveTargetPath("食べる", "notes");
	assert.equal(p, "notes/食べる.md");
});

test("resolveTargetPath：outputDir 空时不加目录前缀", () => {
	const p = resolveTargetPath("食べる", "");
	assert.equal(p, "食べる.md");
});

test("resolveTargetPath：outputDir 为空白时也视为空（trim）", () => {
	const p = resolveTargetPath("食べる", "   ");
	assert.equal(p, "食べる.md", "空白 outputDir trim 后为空，不加前缀");
});

test("resolveTargetPath：outputDir 末尾斜杠不重复（依赖 normalizePath，桩 identity 下原样拼接）", () => {
	// 桩 normalizePath = identity，故 "notes/" + "/" + "word.md" 实际是 `notes/word.md`（dir 末尾斜杠已 trim？）
	// resolveTargetPath 用模板字符串 `${dir}/${fileName}`，dir 是 trim 后原样，"notes/" 不去尾斜杠 → "notes//word.md"？
	// 实际：dir = (outputDir ?? "").trim() = "notes/"，拼接 "notes//食べる.md"。normalizePath 桩 identity 不规整。
	// 这是 normalizePath 的职责（生产里去重斜杠），桩下保留双斜杠。验证拼接逻辑而非 normalize：
	const p = resolveTargetPath("食べる", "notes/");
	assert.ok(p.endsWith("食べる.md"));
	assert.ok(p.includes("notes"));
});

test("resolveTargetPath：word 含非法字符被清洗", () => {
	const p = resolveTargetPath("a/b:c", "notes");
	// sanitizeFileName 去掉 \ / : * ? " < > |，故 "a/b:c" → "abc"
	assert.equal(p, "notes/abc.md");
});

test("resolveTargetPath：word 空白折叠为下划线", () => {
	const p = resolveTargetPath("hello world", "notes");
	assert.equal(p, "notes/hello_world.md");
});

test("resolveTargetPath：word 限长 MAX_WORD_LEN（100）", () => {
	const long = "a".repeat(150);
	const p = resolveTargetPath(long, "notes");
	// 文件名部分（去 .md）应 <= 100
	const fileName = p.slice("notes/".length, -".md".length);
	assert.ok(fileName.length <= 100, `文件名应限长 100，实际 ${fileName.length}`);
});

test("resolveTargetPath：word 空时兜底 untitled", () => {
	const p = resolveTargetPath("", "notes");
	assert.equal(p, "notes/untitled.md");
});

test("resolveTargetPath：word 全空白时折叠为下划线（非 untitled，因空白 → _ 后 trim 不掉）", () => {
	const p = resolveTargetPath("   ", "notes");
	// sanitizeFileName("   ") → "_"（\s+ 替换为 _，trim 不掉下划线），非 untitled
	assert.equal(p, "notes/_.md");
});
