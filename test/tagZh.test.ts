// 测 tagZh/tagLabel/renderNamesDictTerm（纯函数，无 DOM/网络，可单测）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagZh, tagLabel, renderNamesDictTerm } from "../src/dictionary/tagZh.ts";

test("tagZh：单 tag 命中映射", () => {
	assert.equal(tagZh("surname"), "姓");
	assert.equal(tagZh("place"), "地名");
});

test("tagZh：组合 tag 按空格拆分映射后用 / 拼接", () => {
	assert.equal(tagZh("fem person"), "女名/人物");
	assert.equal(tagZh("surname masc"), "姓/男名");
});

test("tagZh：未命中映射保留原 tag（Jitendex 词性码等不映射）", () => {
	assert.equal(tagZh("v1"), "v1");
	assert.equal(tagZh("adj-i"), "adj-i");
	assert.equal(tagZh("unknown-tag"), "unknown-tag");
});

test("tagLabel：英文原名 + 中文名", () => {
	assert.equal(tagLabel("surname"), "surname 姓");
	assert.equal(tagLabel("fem person"), "fem person 女名/人物");
});

test("tagLabel：未命中映射时只显示原 tag（不重复）", () => {
	assert.equal(tagLabel("v1"), "v1");
	assert.equal(tagLabel("unknown-tag"), "unknown-tag");
});

test("renderNamesDictTerm：单 tag + 单读音", () => {
	assert.equal(
		renderNamesDictTerm(["surname"], ["なかむら"]),
		"  surname 姓 なかむら",
	);
});

test("renderNamesDictTerm：单 tag + 多读音（顿号分隔）", () => {
	assert.equal(
		renderNamesDictTerm(["surname"], ["おかむら", "なかむら", "よねじ"]),
		"  surname 姓 おかむら、なかむら、よねじ",
	);
});

test("renderNamesDictTerm：组合 tag", () => {
	assert.equal(
		renderNamesDictTerm(["fem", "person"], ["あいか"]),
		"  fem 女名 person 人物 あいか",
	);
});

test("renderNamesDictTerm：无 tag 时只显示读音", () => {
	assert.equal(
		renderNamesDictTerm([], ["なかむら"]),
		"  なかむら",
	);
});

test("renderNamesDictTerm：glossary 含非字符串元素被过滤", () => {
	assert.equal(
		renderNamesDictTerm(["place"], ["なかむら", { x: 1 }, "もう一つ"]),
		"  place 地名 なかむら、もう一つ",
	);
});

test("renderNamesDictTerm：与 buildDictionaryReference 一致格式（缩进两空格）", () => {
	// 模拟「中村」的一条 surname term：与 popup 展示语义一致
	const line = renderNamesDictTerm(["surname"], ["おかむら", "かなかむら", "なかむら"]);
	assert.equal(line, "  surname 姓 おかむら、かなかむら、なかむら");
});
