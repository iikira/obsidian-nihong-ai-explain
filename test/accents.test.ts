import { test } from "node:test";
import assert from "node:assert/strict";
import { AccentDb } from "../src/dictionary/accents.ts";

test("AccentDb：解析 TSV 并查询", () => {
	const db = new AccentDb();
	db.load("病む\tやむ\t0\n食べる\tたべる\t1\n");
	assert.deepEqual(db.lookup("病む", "やむ"), [0]);
	assert.deepEqual(db.lookup("食べる", "たべる"), [1]);
});

test("AccentDb：多声调逗号分隔", () => {
	const db = new AccentDb();
	db.load("漢字\tかんじ\t4,0\n");
	// 多声调保留为候选数组
	assert.deepEqual(db.lookup("漢字", "かんじ"), [4, 0]);
});

test("AccentDb：词性标注剥离（(副)0,(名)3）", () => {
	const db = new AccentDb();
	db.load("言葉\tことば\t(副)0,(名)3\n");
	assert.deepEqual(db.lookup("言葉", "ことば"), [0, 3]);
});

test("AccentDb：同 expression+reading 多行合并去重", () => {
	const db = new AccentDb();
	db.load("病む\tやむ\t0\n病む\tやむ\t1\n");
	assert.deepEqual(db.lookup("病む", "やむ"), [0, 1]);
});

test("AccentDb：isLoaded", () => {
	const db = new AccentDb();
	assert.equal(db.isLoaded, false);
	db.load("病む\tやむ\t0\n");
	assert.equal(db.isLoaded, true);
});

test("AccentDb：纯假名词按 reading 兜底", () => {
	const db = new AccentDb();
	// expression === reading 的纯假名词，按 reading 兜底匹配
	db.load("やむ\tやむ\t0\n");
	assert.deepEqual(db.lookup("やむ", "やむ"), [0]);
});

test("AccentDb：查无结果返回空数组", () => {
	const db = new AccentDb();
	db.load("病む\tやむ\t0\n");
	assert.deepEqual(db.lookup("存在しない", "そんざいしない"), []);
});

test("AccentDb：忽略格式不合法的行", () => {
	const db = new AccentDb();
	db.load("病む\tやむ\n\n不正\n病む\tやむ\t0\n");
	assert.deepEqual(db.lookup("病む", "やむ"), [0]);
});
