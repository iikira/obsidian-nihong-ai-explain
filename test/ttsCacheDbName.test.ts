import { test } from "node:test";
import assert from "node:assert/strict";
import { ttsCacheDbName } from "../src/tts/cache.ts";

test("ttsCacheDbName：正常 vault 名拼接后缀", () => {
	assert.equal(
		ttsCacheDbName("我的日语笔记"),
		"nihong-ai-tts-cache-v2-我的日语笔记",
	);
	assert.equal(
		ttsCacheDbName("vault-a"),
		"nihong-ai-tts-cache-v2-vault-a",
	);
});

test("ttsCacheDbName：含文件名非法字符替换为下划线", () => {
	// 文件名非法字符 \ / : * ? " < > | 替换为 _
	assert.equal(
		ttsCacheDbName('a/b:c*d?e"f<g>h|i'),
		"nihong-ai-tts-cache-v2-a_b_c_d_e_f_g_h_i",
	);
});

test("ttsCacheDbName：连续空白折叠为单个下划线", () => {
	// 中间连续空白折叠为单个 _
	assert.equal(
		ttsCacheDbName("my vault"),
		"nihong-ai-tts-cache-v2-my_vault",
	);
	assert.equal(
		ttsCacheDbName("a   b\tc"),
		"nihong-ai-tts-cache-v2-a_b_c",
	);
});

test("ttsCacheDbName：清洗后为空回退默认名", () => {
	// 空字符串 / 仅空白 → trim 后空 → 回退默认名
	assert.equal(ttsCacheDbName(""), "nihong-ai-tts-cache-v2");
	assert.equal(ttsCacheDbName("   "), "nihong-ai-tts-cache-v2");
	assert.equal(ttsCacheDbName("\t\n"), "nihong-ai-tts-cache-v2");
});

test("ttsCacheDbName：全为非法字符替换为下划线（合法库名，不回退）", () => {
	// 全为文件名非法字符 → 全替换为 _（合法库名，非空故不回退）
	assert.equal(ttsCacheDbName("///"), "nihong-ai-tts-cache-v2-___");
	assert.equal(ttsCacheDbName('\\:*?"<>|'), "nihong-ai-tts-cache-v2-________");
});

test("ttsCacheDbName：控制字符替换为下划线", () => {
	// 控制字符（\x00-\x1f，含 \t \n）替换为 _（与空白折叠合并处理）
	assert.equal(
		ttsCacheDbName("a\tb\nc"),
		"nihong-ai-tts-cache-v2-a_b_c",
	);
});
