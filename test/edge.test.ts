import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEdgeRate } from "../src/tts/edge.ts";

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
