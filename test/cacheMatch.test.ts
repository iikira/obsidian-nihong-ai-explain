// 测缓存联动匹配：翻译缓存 ↔ 朗读缓存按 text 互相命中。
//   matchTranslateWithTTS：给翻译条目附命中的朗读 blobUrl
//   matchTTSWithTranslate：给朗读条目附命中的译文
//   规则：同 text 命中；多个同 text 取第一个（entries 已按最近使用在前排序）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	matchTranslateWithTTS,
	matchTTSWithTranslate,
	type TranslateCacheEntry,
	type TTSCacheEntry,
} from "../src/cacheMatch.ts";

const tts = (text: string, blobUrl: string, engine = "google"): TTSCacheEntry => ({
	text,
	blobUrl,
	engine,
	voice: "",
});

const tr = (text: string, value: string, target = "中文"): TranslateCacheEntry => ({
	text,
	value,
	target,
});

test("matchTranslateWithTTS：命中时附上 blobUrl", () => {
	const matched = matchTranslateWithTTS([tr("你好", "hello")], [tts("你好", "blob:A")]);
	assert.equal(matched.length, 1);
	assert.equal(matched[0].ttsBlobUrl, "blob:A");
});

test("matchTranslateWithTTS：未命中时 blobUrl 为 null", () => {
	const matched = matchTranslateWithTTS([tr("你好", "hello")], [tts("再见", "blob:B")]);
	assert.equal(matched[0].ttsBlobUrl, null);
});

test("matchTranslateWithTTS：空朗读缓存全部 null", () => {
	const matched = matchTranslateWithTTS(
		[tr("A", "a"), tr("B", "b")],
		[],
	);
	assert.equal(matched[0].ttsBlobUrl, null);
	assert.equal(matched[1].ttsBlobUrl, null);
});

test("matchTranslateWithTTS：多个同 text 朗读条目取第一个（最近使用）", () => {
	const matched = matchTranslateWithTTS(
		[tr("你好", "hello")],
		[tts("你好", "blob:first"), tts("你好", "blob:second")],
	);
	assert.equal(matched[0].ttsBlobUrl, "blob:first");
});

test("matchTranslateWithTTS：保留翻译条目原字段", () => {
	const matched = matchTranslateWithTTS(
		[tr("你好", "hello", "英文")],
		[tts("你好", "blob:A", "edge")],
	);
	assert.equal(matched[0].text, "你好");
	assert.equal(matched[0].value, "hello");
	assert.equal(matched[0].target, "英文");
});

test("matchTTSWithTranslate：命中时附上译文", () => {
	const matched = matchTTSWithTranslate([tts("你好", "blob:A")], [tr("你好", "hello")]);
	assert.equal(matched.length, 1);
	assert.equal(matched[0].translation, "hello");
});

test("matchTTSWithTranslate：未命中时 translation 为 null", () => {
	const matched = matchTTSWithTranslate([tts("你好", "blob:A")], [tr("再见", "bye")]);
	assert.equal(matched[0].translation, null);
});

test("matchTTSWithTranslate：空翻译缓存全部 null", () => {
	const matched = matchTTSWithTranslate(
		[tts("A", "a"), tts("B", "b")],
		[],
	);
	assert.equal(matched[0].translation, null);
	assert.equal(matched[1].translation, null);
});

test("matchTTSWithTranslate：多个同 text 翻译条目取第一个（最近使用）", () => {
	const matched = matchTTSWithTranslate(
		[tts("你好", "blob:A")],
		[tr("你好", "first"), tr("你好", "second")],
	);
	assert.equal(matched[0].translation, "first");
});

test("matchTTSWithTranslate：保留朗读条目原字段", () => {
	const matched = matchTTSWithTranslate(
		[tts("你好", "blob:A", "edge")],
		[tr("你好", "hello")],
	);
	assert.equal(matched[0].text, "你好");
	assert.equal(matched[0].blobUrl, "blob:A");
	assert.equal(matched[0].engine, "edge");
});

test("双向匹配：同一对条目互相命中", () => {
	const tEntries = [tr("共通", "common")];
	const ttsEntries = [tts("共通", "blob:common")];
	const tm = matchTranslateWithTTS(tEntries, ttsEntries);
	const tm2 = matchTTSWithTranslate(ttsEntries, tEntries);
	assert.equal(tm[0].ttsBlobUrl, "blob:common");
	assert.equal(tm2[0].translation, "common");
});
