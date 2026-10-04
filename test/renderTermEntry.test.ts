import { test } from "node:test";
import assert from "node:assert/strict";
import { toAccentCircle, renderTermEntry } from "../src/explain/renderTerm.ts";

test("toAccentCircle：0 → ⓪", () => {
	assert.equal(toAccentCircle(0), "⓪");
});

test("toAccentCircle：1-20 → ①-⑳", () => {
	assert.equal(toAccentCircle(1), "①");
	assert.equal(toAccentCircle(2), "②");
	assert.equal(toAccentCircle(20), "⑳");
});

test("toAccentCircle：>20 退化为括号数字", () => {
	assert.equal(toAccentCircle(21), "(21)");
});

test("renderTermEntry：病む（li 结构 sense-group/sense）", () => {
	// 简化的 Jitendex 结构：sense-group 用 li/ol/li，sense 带 listStyleType ①
	const glossary = {
		type: "structured-content",
		content: [
			{
				tag: "ul",
				data: { content: "sense-groups" },
				content: [
					{
						tag: "li",
						data: { content: "sense-group" },
						content: [
							{ tag: "span", data: { content: "part-of-speech-info" }, content: "5-dan" },
							{ tag: "span", data: { content: "part-of-speech-info" }, content: "intransitive" },
							{
								tag: "ol",
								content: [
									{
										tag: "li",
										style: { listStyleType: '"①"' },
										data: { content: "sense" },
										content: [
											{
												tag: "ul",
												data: { content: "glossary" },
												content: [{ tag: "li", content: "to fall ill" }],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		],
	};
	const lines = renderTermEntry(glossary);
	assert.deepEqual(lines, [
		"  5-dan; intransitive;",
		"  ① to fall ill",
	]);
});

test("renderTermEntry：奥行き（div 结构 sense-group/sense）", () => {
	// sense-group 与 sense 都是 div（非 li/ol），验证不依赖 tag
	const glossary = {
		type: "structured-content",
		content: [
			{
				tag: "div",
				data: { content: "sense-group" },
				content: [
					{ tag: "span", data: { content: "part-of-speech-info" }, content: "noun" },
					{
						tag: "div",
						data: { content: "sense" },
						content: [
							{
								tag: "ul",
								data: { content: "glossary" },
								content: [
									{ tag: "li", content: "depth" },
									{ tag: "li", content: "length" },
								],
							},
						],
					},
				],
			},
		],
	};
	const lines = renderTermEntry(glossary);
	assert.deepEqual(lines, [
		"  noun;",
		"  depth; length",
	]);
});

test("renderTermEntry：attribution 块丢弃", () => {
	// 真实词条：sense-group + attribution 块（JMdict | Tatoeba）应被丢弃，不出现在输出
	const glossary = {
		type: "structured-content",
		content: [
			{
				tag: "div",
				data: { content: "sense-group" },
				content: [
					{ tag: "span", data: { content: "part-of-speech-info" }, content: "noun" },
					{
						tag: "div",
						data: { content: "sense" },
						content: [
							{
								tag: "ul",
								data: { content: "glossary" },
								content: [{ tag: "li", content: "depth" }],
							},
						],
					},
				],
			},
			{
				tag: "div",
				data: { content: "attribution" },
				content: [
					{ tag: "a", href: "https://edrdg.org", content: "JMdict" },
					" | ",
					{ tag: "a", href: "https://tatoeba.org", content: "Tatoeba" },
				],
			},
		],
	};
	const lines = renderTermEntry(glossary);
	assert.deepEqual(lines, [
		"  noun;",
		"  depth",
	]);
});

test("renderTermEntry：例句日文去 ruby 假名 + 译文", () => {
	const glossary = {
		type: "structured-content",
		content: [
			{
				tag: "div",
				data: { content: "sense-group" },
				content: [
					{ tag: "span", data: { content: "part-of-speech-info" }, content: "noun" },
					{
						tag: "div",
						data: { content: "sense" },
						content: [
							{
								tag: "ul",
								data: { content: "glossary" },
								content: [{ tag: "li", content: "depth" }],
							},
							{
								tag: "div",
								data: { content: "extra-info" },
								content: {
									tag: "div",
									content: {
										tag: "div",
										data: { content: "example-sentence" },
										content: [
											{
												tag: "div",
												data: { content: "example-sentence-a" },
												content: {
													tag: "span",
													lang: "ja",
													content: [
														{ tag: "ruby", content: ["間", { tag: "rt", content: "ま" }] },
														{ tag: "ruby", content: ["口", { tag: "rt", content: "ぐち" }] },
														"も広い",
													],
												},
											},
											{
												tag: "div",
												data: { content: "example-sentence-b" },
												content: { tag: "span", lang: "en", content: "It's wide." },
											},
										],
									},
								},
							},
						],
					},
				],
			},
		],
	};
	const lines = renderTermEntry(glossary);
	assert.deepEqual(lines, [
		"  noun;",
		"  depth",
		"    間口も広い",
		"    It's wide.",
	]);
});

test("renderTermEntry：attribution-footnote 脚注丢弃", () => {
	// 译文末尾的 [1] 脚注 span 不应混入译文
	const glossary = {
		type: "structured-content",
		content: [
			{
				tag: "div",
				data: { content: "sense-group" },
				content: [
					{ tag: "span", data: { content: "part-of-speech-info" }, content: "noun" },
					{
						tag: "div",
						data: { content: "sense" },
						content: [
							{
								tag: "ul",
								data: { content: "glossary" },
								content: [{ tag: "li", content: "depth" }],
							},
							{
								tag: "div",
								data: { content: "extra-info" },
								content: {
									tag: "div",
									content: {
										tag: "div",
										data: { content: "example-sentence" },
										content: [
											{
												tag: "div",
												data: { content: "example-sentence-b" },
												content: [
													{ tag: "span", lang: "en", content: "It's wide." },
													{ tag: "span", data: { content: "attribution-footnote" }, content: "[1]" },
												],
											},
										],
									},
								},
							},
						],
					},
				],
			},
		],
	};
	const lines = renderTermEntry(glossary);
	// 译文不含 [1]
	assert.deepEqual(lines, [
		"  noun;",
		"  depth",
		"    It's wide.",
	]);
});

test("renderTermEntry：纯文本 glossary 兜底", () => {
	const glossary = ["to fall ill", "to be ill"];
	const lines = renderTermEntry(glossary);
	// textOf 把数组字符串直接拼接（无分隔），整体作为一条释义
	assert.deepEqual(lines, ["  to fall illto be ill"]);
});
