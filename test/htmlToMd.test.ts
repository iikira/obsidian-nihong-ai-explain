import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLink, createImageCollector } from "../src/converter/htmlToMd.ts";

test("resolveLink：空 href 返回 null", () => {
	assert.equal(resolveLink(""), null);
	assert.equal(resolveLink("   "), null);
});

test("resolveLink：外部链接原样返回", () => {
	assert.equal(resolveLink("https://example.com"), "https://example.com");
	assert.equal(resolveLink("http://foo.bar/baz"), "http://foo.bar/baz");
	assert.equal(resolveLink("mailto:a@b.com"), "mailto:a@b.com");
});

test("resolveLink：外部链接无需 resolver", () => {
	// 即使无 resolver，外部链接仍原样返回
	assert.equal(resolveLink("https://example.com"), "https://example.com");
});

test("resolveLink：内部链接交 resolver 改写", () => {
	const resolver = (href: string): string | null => {
		if (href === "p-001.xhtml#toc-001") return "005_p-001.md#toc-001";
		return null;
	};
	assert.equal(resolveLink("p-001.xhtml#toc-001", resolver), "005_p-001.md#toc-001");
});

test("resolveLink：resolver 返回 null 时返回 null", () => {
	const resolver = (_: string): string | null => null;
	assert.equal(resolveLink("unknown.xhtml", resolver), null);
});

test("resolveLink：无 resolver 时内部链接返回 null", () => {
	assert.equal(resolveLink("p-001.xhtml#toc-001"), null);
	assert.equal(resolveLink("p-001.xhtml"), null);
});

test("createImageCollector：生成 images/<filename> 引用", () => {
	const c = createImageCollector();
	assert.equal(c.resolve("image/cover.jpg"), "images/cover.jpg");
	assert.equal(c.resolve("image/a.png"), "images/a.png");
	assert.equal(c.placeholders.length, 2);
});

test("createImageCollector：同 src 复用同一文件名", () => {
	const c = createImageCollector();
	c.resolve("image/cover.jpg");
	c.resolve("image/cover.jpg"); // 同 src
	assert.equal(c.placeholders.length, 1); // 不重复收集
});

test("createImageCollector：无扩展名补 .png", () => {
	const c = createImageCollector();
	assert.equal(c.resolve("image/photo"), "images/photo.png");
});

test("createImageCollector：去 query/hash 取文件名", () => {
	const c = createImageCollector();
	assert.equal(c.resolve("image/cover.jpg?v=1"), "images/cover.jpg");
	// 同 src 不同 query/hash 不重复收集（baseName 相同，但 src 不同 → 视为不同图片，去重加前缀）
	assert.equal(c.resolve("image/cover.jpg#sec"), "images/1_cover.jpg");
});

test("createImageCollector：重名冲突加 n_ 前缀", () => {
	const c = createImageCollector();
	// 不同 src 同 basename
	assert.equal(c.resolve("a/cover.jpg"), "images/cover.jpg");
	assert.equal(c.resolve("b/cover.jpg"), "images/1_cover.jpg");
	assert.equal(c.placeholders.length, 2);
});

test("createImageCollector：URL 编码文件名解码", () => {
	const c = createImageCollector();
	assert.equal(c.resolve("image/%E6%97%A5%E6%9C%AC.jpg"), "images/日本.jpg");
});
