import { test } from "node:test";
import assert from "node:assert/strict";
import { getFuriganaSegments } from "../src/dictionary/furigana.ts";

test("getFuriganaSegments：单汉字整词读音", () => {
	const segs = getFuriganaSegments("漢字", "かんじ");
	assert.deepEqual(segs, [{ text: "漢字", reading: "かんじ" }]);
});

test("getFuriganaSegments：汉字+假名混合对齐", () => {
	const segs = getFuriganaSegments("美味しい", "おいしい");
	// 汉字块贪心匹配最大可对齐 prefix：美味↔おい，剩下 しい 无注音
	assert.deepEqual(segs, [
		{ text: "美味", reading: "おい" },
		{ text: "しい", reading: "" },
	]);
});

test("getFuriganaSegments：纯假名无注音", () => {
	const segs = getFuriganaSegments("やむ", "やむ");
	assert.deepEqual(segs, [{ text: "やむ", reading: "" }]);
});

test("getFuriganaSegments：片假名读音归一化为平假名", () => {
	// reading 为片假名时归一化为平假名后与 expression 汉字块匹配，reading 返回归一化的平假名
	const segs = getFuriganaSegments("漢字", "カンジ");
	assert.deepEqual(segs, [{ text: "漢字", reading: "かんじ" }]);
});

test("getFuriganaSegments：多汉字可整组对齐", () => {
	// 夫婦/ふうふ：汉字块贪心匹配整词读音
	const segs = getFuriganaSegments("夫婦", "ふうふ");
	assert.deepEqual(segs, [{ text: "夫婦", reading: "ふうふ" }]);
});

test("getFuriganaSegments：对齐失败兜底整段", () => {
	// reading 完全对不上 expression 的假名块时，兜底整段
	const segs = getFuriganaSegments("漢字x", "あいうえお");
	// 对齐失败：整段返回，reading 为整体
	assert.equal(segs.length, 1);
	assert.equal(segs[0].text, "漢字x");
});
