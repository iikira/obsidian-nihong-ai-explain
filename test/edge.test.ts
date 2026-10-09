import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSecMsGec, buildSSML, formatEdgeRate } from "../src/tts/edge.ts";

test("generateSecMsGec：固定时间戳生成确定的 SHA256 大写 hex", () => {
	// 固定时间戳 1728450000（2024-10-09），与 Python edge-tts 算法对照
	const hash = generateSecMsGec(1728450000);
	// 与 Python edge-tts（rany2/edge-tts）算法结果一致
	assert.equal(hash, "6F9F1B54BA2EDE011BD16CA72E208631A56874745B304F31521FE9E8B0BF276E");
	// 大写 hex，长度 64
	assert.match(hash, /^[0-9A-F]{64}$/);
});

test("generateSecMsGec：5 分钟内向同一时间点取整（同一窗口内稳定）", () => {
	const base = 1728450000;
	// base 是 300 的整数倍，base 与 base+299 应生成同一 token（同一 5 分钟窗口）
	assert.equal(generateSecMsGec(base), generateSecMsGec(base + 299));
	// base+300 进入下一窗口，token 应不同
	assert.notEqual(generateSecMsGec(base), generateSecMsGec(base + 300));
});

test("formatEdgeRate：1.0 → +0%", () => {
	assert.equal(formatEdgeRate(1.0), "+0%");
});

test("formatEdgeRate：2.0 → +100%", () => {
	assert.equal(formatEdgeRate(2.0), "+100%");
});

test("formatEdgeRate：0.5 → -50%", () => {
	assert.equal(formatEdgeRate(0.5), "-50%");
});

test("formatEdgeRate：负百分比带负号", () => {
	assert.equal(formatEdgeRate(0.9), "-10%");
});

test("formatEdgeRate：超出上界 clamp 到 +100%", () => {
	// 3.0 → +200% 被 clamp 到 +100%
	assert.equal(formatEdgeRate(3.0), "+100%");
});

test("formatEdgeRate：低于下界 clamp 到 -50%", () => {
	// 0.1 → -90% 被 clamp 到 -50%
	assert.equal(formatEdgeRate(0.1), "-50%");
});

test("buildSSML：包含语音名与文本，文本做 XML 转义", () => {
	const ssml = buildSSML("こんにちは<&>世界", "ja-JP-NanamiNeural", "+0%");
	assert.ok(ssml.includes("<voice name='ja-JP-NanamiNeural'>"));
	assert.ok(ssml.includes("rate='+0%'"));
	// 特殊字符转义
	assert.ok(ssml.includes("&amp;"));
	assert.ok(ssml.includes("&lt;"));
	assert.ok(ssml.includes("&gt;"));
	// 原始特殊字符不应出现在 prosody 内容区
	assert.ok(!ssml.includes("<&>"));
});

test("buildSSML：speak 根元素与 prosody 结构完整", () => {
	const ssml = buildSSML("テスト", "ja-JP-KeitaNeural", "-10%", "+5Hz", "+20%");
	assert.ok(ssml.startsWith("<speak version='1.0'"));
	assert.ok(ssml.includes("pitch='+5Hz'"));
	assert.ok(ssml.includes("volume='+20%'"));
	assert.ok(ssml.endsWith("</speak>"));
});
