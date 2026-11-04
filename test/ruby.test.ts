import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRuby } from "../src/converter/ruby.ts";
import {
	xhtmlToMarkdown,
	createImageCollector,
} from "../src/converter/htmlToMd.ts";

// ---------- stripRuby ----------

test("stripRuby：基础 ruby 保留基底汉字、丢弃注音", () => {
	const html = `<p><ruby>漢字<rt>かんじ</rt></ruby>の読み</p>`;
	const out = stripRuby(html);
	assert.equal(out, `<p>漢字の読み</p>`);
});

test("stripRuby：多个 ruby 逐一剥离", () => {
	const html = `<ruby>今日<rt>きょう</rt></ruby>は<ruby>天気<rt>てんき</rt></ruby>`;
	assert.equal(stripRuby(html), `今日は天気`);
});

test("stripRuby：含 rp 注音括号一并移除", () => {
	const html = `<ruby>漢<rt>かん</rt></ruby><ruby>字<rt>じ</rt></ruby>`;
	assert.equal(stripRuby(html), `漢字`);
});

test("stripRuby：无 ruby 原样返回", () => {
	const html = `<p>普通のテキスト</p>`;
	assert.equal(stripRuby(html), `<p>普通のテキスト</p>`);
});

// ---------- xhtmlToMarkdown 保留 ruby ----------

test("xhtmlToMarkdown：保留 ruby 注音标签", () => {
	const html = `<p><ruby>漢字<rt>かんじ</rt></ruby>の読み</p>`;
	const collector = createImageCollector();
	const md = xhtmlToMarkdown(html, collector);
	assert.equal(md, `<ruby>漢字<rt>かんじ</rt></ruby>の読み`);
});

test("xhtmlToMarkdown：保留多个 ruby 与 rp 括号", () => {
	const html = `<p><ruby>今日<rt>きょう</rt></ruby>は<ruby>天気<rt>てんき</rt></ruby></p>`;
	const collector = createImageCollector();
	const md = xhtmlToMarkdown(html, collector);
	assert.equal(md, `<ruby>今日<rt>きょう</rt></ruby>は<ruby>天気<rt>てんき</rt></ruby>`);
});

// ---------- 端到端：先 stripRuby 再 xhtmlToMarkdown（关闭保留开关的路径） ----------

test("关闭保留：stripRuby + xhtmlToMarkdown 只留基底汉字", () => {
	const html = `<p><ruby>漢字<rt>かんじ</rt></ruby>の読み</p>`;
	const stripped = stripRuby(html);
	const collector = createImageCollector();
	const md = xhtmlToMarkdown(stripped, collector);
	assert.equal(md, `漢字の読み`);
});

test("开启保留：直接 xhtmlToMarkdown 保留注音", () => {
	const html = `<p><ruby>漢字<rt>かんじ</rt></ruby>の読み</p>`;
	const collector = createImageCollector();
	const md = xhtmlToMarkdown(html, collector);
	assert.equal(md, `<ruby>漢字<rt>かんじ</rt></ruby>の読み`);
});
