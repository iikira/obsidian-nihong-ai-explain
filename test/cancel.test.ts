// 测 cancel.ts 的纯逻辑：createCancelToken、CancelledError、throwIfCancelled。
// showCancellableProgress 依赖 Notice/createFragment（UI），不测。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createCancelToken,
	CancelledError,
	throwIfCancelled,
} from "../src/cancel.ts";

test("createCancelToken：初始 cancelled 为 false", () => {
	const token = createCancelToken();
	assert.equal(token.cancelled, false);
});

test("createCancelToken：每次返回新对象（互不影响）", () => {
	const a = createCancelToken();
	const b = createCancelToken();
	a.cancelled = true;
	assert.equal(b.cancelled, false, "a 的修改不应影响 b");
});

test("throwIfCancelled：未取消时不抛", () => {
	const token = createCancelToken();
	assert.doesNotThrow(() => throwIfCancelled(token));
});

test("throwIfCancelled：取消后抛 CancelledError", () => {
	const token = createCancelToken();
	token.cancelled = true;
	assert.throws(() => throwIfCancelled(token), CancelledError);
});

test("throwIfCancelled：抛出的错误名是 CancelledError", () => {
	const token = createCancelToken();
	token.cancelled = true;
	try {
		throwIfCancelled(token);
		assert.fail("应抛错");
	} catch (e) {
		assert.ok(e instanceof CancelledError);
		assert.equal(e.name, "CancelledError");
		assert.equal(e.message, "已取消");
	}
});

test("CancelledError 是 Error 子类", () => {
	const e = new CancelledError();
	assert.ok(e instanceof Error);
	assert.ok(e instanceof CancelledError);
});
