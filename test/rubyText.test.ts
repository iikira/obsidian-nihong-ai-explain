import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSelectionText, stripRtFromFragment } from "../src/utils/rubyText.ts";

/** 用 DOMParser 解析 HTML，把 body 子节点装入 DocumentFragment（模拟 range.cloneContents()） */
function fragmentFromHtml(html: string): DocumentFragment {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const fragment = doc.createDocumentFragment();
	for (const child of Array.from(doc.body.childNodes)) {
		fragment.appendChild(child);
	}
	return fragment;
}

// ---------- cleanSelectionText：纯字符串层清理字面 <ruby><rt> 标签 ----------

test("cleanSelectionText：基础 ruby 保留基底汉字、去注音", () => {
	const text = `<ruby>漢字<rt>かんじ</rt></ruby>の読み`;
	assert.equal(cleanSelectionText(text), `漢字の読み`);
});

test("cleanSelectionText：多个 ruby 逐一清理", () => {
	const text = `<ruby>今日<rt>きょう</rt></ruby>は<ruby>天気<rt>てんき</rt></ruby>`;
	assert.equal(cleanSelectionText(text), `今日は天気`);
});

test("cleanSelectionText：含 rp 注音括号一并清理", () => {
	const text = `<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>`;
	assert.equal(cleanSelectionText(text), `漢字`);
});

test("cleanSelectionText：无 ruby 原样返回", () => {
	const text = `普通のテキスト`;
	assert.equal(cleanSelectionText(text), `普通のテキスト`);
});

test("cleanSelectionText：属性与大写标签", () => {
	const text = `<RUBY CLASS="x">漢字<RT>かんじ</RT></RUBY>`;
	assert.equal(cleanSelectionText(text), `漢字`);
});

test("cleanSelectionText：rt 跨行内容", () => {
	const text = `<ruby>漢字<rt>\nかんじ\n</rt></ruby>`;
	assert.equal(cleanSelectionText(text), `漢字`);
});

test("cleanSelectionText：未配对残留标签兜底去标签字符（内容保留，无法判定注音边界）", () => {
	const text = `漢字<rt>かんじ`;
	assert.equal(cleanSelectionText(text), `漢字かんじ`);
});

test("cleanSelectionText：标签前后多余空白压缩", () => {
	const text = `<ruby>漢字<rt>かんじ</rt></ruby>  の読み`;
	assert.equal(cleanSelectionText(text), `漢字 の読み`);
});

// ---------- stripRtFromFragment：DOM fragment 层移除 <rt>/<rp>（Reading 视图场景）----------

test("stripRtFromFragment：含 <ruby> 包裹的 fragment 移除注音", () => {
	const fragment = fragmentFromHtml(`<ruby>卓<rt>ちや</rt>袱<rt>ぶ</rt>台</ruby>`);
	assert.equal(stripRtFromFragment(fragment), `卓袱台`);
});

test("stripRtFromFragment：选区在 ruby 内部，fragment 无 <ruby> 包裹只有孤立 <rt>", () => {
	// 模拟 Reading 视图选中 ruby 内部：cloneContents() 返回的 fragment 只有 ruby 的子节点
	const fragment = fragmentFromHtml(`卓<rt>ちや</rt>袱<rt>ぶ</rt>台`);
	assert.equal(stripRtFromFragment(fragment), `卓袱台`);
});

test("stripRtFromFragment：含 <rp> 注音括号一并移除", () => {
	const fragment = fragmentFromHtml(`<ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby>`);
	assert.equal(stripRtFromFragment(fragment), `漢`);
});

test("stripRtFromFragment：无 rt/rp 的 fragment 原样文本", () => {
	const fragment = fragmentFromHtml(`普通のテキスト`);
	assert.equal(stripRtFromFragment(fragment), `普通のテキスト`);
});
