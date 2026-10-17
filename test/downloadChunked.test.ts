import { test, before, after } from "node:test";
import assert from "node:assert/strict";
// downloadChunked 是 src/dictionary/manager.ts 的模块级纯函数，接收注入的
// requestFn（mock）与 adapter（内存版），不依赖 Obsidian API / 网络 / DOM。
// sleep 是 Obsidian 全局函数（测试 stub 成 undefined），mock 为同步 noop 避免真实等待。
import {
	downloadChunked,
	type ChunkRequestFn,
	type ChunkFileAdapter,
} from "../src/dictionary/manager";

// mock 全局 sleep（downloadChunked 重试时调用），同步 noop
const origSleep = (globalThis as { sleep?: unknown }).sleep;
before(() => {
	(globalThis as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
});
after(() => {
	if (origSleep === undefined) {
		delete (globalThis as { sleep?: unknown }).sleep;
	} else {
		(globalThis as { sleep?: unknown }).sleep = origSleep;
	}
});

/** 构造一个按内容长度切片的 mock requestFn：
 *  - HEAD 返回 Content-Length
 *  - GET 带 Range 返回对应分片（206）
 *  - failures[rangeHeader] 指定某些分片前 N 次请求抛错（模拟瞬时失败），第 N+1 次成功
 */
function makeRequestFn(
	totalBytes: Uint8Array,
	opts: { failures?: Record<string, number> } = {},
): ChunkRequestFn {
	const failures = { ...opts.failures };
	const attemptCount: Record<string, number> = {};
	return async (params) => {
		if (params.method === "HEAD") {
			return {
				status: 200,
				arrayBuffer: new ArrayBuffer(0),
				headers: { "content-length": String(totalBytes.length) },
			};
		}
		// GET
		const range = params.headers?.Range ?? "";
		const m = range.match(/^bytes=(\d+)-(\d+)$/);
		if (!m) {
			throw new Error(`未预期的 Range: ${range}`);
		}
		const start = parseInt(m[1], 10);
		const end = parseInt(m[2], 10);
		// 失败注入：前 N 次抛错
		attemptCount[range] = (attemptCount[range] ?? 0) + 1;
		if (failures[range] && attemptCount[range] <= failures[range]) {
			throw new Error(`模拟失败 ${range} 第 ${attemptCount[range]} 次`);
		}
		const slice = totalBytes.slice(start, end + 1);
		return {
			status: 206,
			arrayBuffer: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
			headers: { "content-length": String(slice.byteLength) },
		};
	};
}

/** 内存版 adapter：累积写入的字节，支持 remove 清空。返回 adapter + 读取已写字节的函数。 */
function makeMemoryAdapter(): { adapter: ChunkFileAdapter; written: () => Uint8Array; bytes: Uint8Array[] } {
	const bytes: Uint8Array[] = [];
	const adapter: ChunkFileAdapter = {
		async writeBinary(_path: string, data: ArrayBuffer): Promise<void> {
			bytes.length = 0;
			bytes.push(new Uint8Array(data));
		},
		async appendBinary(_path: string, data: ArrayBuffer): Promise<void> {
			bytes.push(new Uint8Array(data));
		},
		async remove(_path: string): Promise<void> {
			bytes.length = 0;
		},
	};
	const written = (): Uint8Array => {
		const total = bytes.reduce((s, b) => s + b.length, 0);
		const out = new Uint8Array(total);
		let off = 0;
		for (const b of bytes) {
			out.set(b, off);
			off += b.length;
		}
		return out;
	};
	return { adapter, written, bytes };
}

test("downloadChunked：正常分片下载，完整拼接", async () => {
	// 12MB 数据，chunkSize 5MB → 3 片（5MB + 5MB + 2MB）
	const total = 12 * 1024 * 1024;
	const data = new Uint8Array(total);
	for (let i = 0; i < total; i++) {
		data[i] = i & 0xff;
	}
	const fn = makeRequestFn(data);
	const { adapter, written } = makeMemoryAdapter();
	await downloadChunked(fn, adapter, "https://example.com/x.zip", "/x.zip", {
		chunkSize: 5 * 1024 * 1024,
		maxRetries: 3,
		retryInterval: 0,
	});
	assert.deepEqual(written(), data, "下载拼接应等于原数据");
});

test("downloadChunked：单分片失败重试成功", async () => {
	const total = 8 * 1024 * 1024;
	const data = new Uint8Array(total);
	data.fill(42);
	const fn = makeRequestFn(data, {
		// 第 2 片前 2 次失败，第 3 次成功（maxRetries=3 → 成功）
		failures: { "bytes=5242880-8388607": 2 },
	});
	const { adapter, written } = makeMemoryAdapter();
	await downloadChunked(fn, adapter, "https://example.com/x.zip", "/x.zip", {
		chunkSize: 5 * 1024 * 1024,
		maxRetries: 3,
		retryInterval: 0,
	});
	assert.deepEqual(written(), data, "重试成功后拼接应等于原数据");
});

test("downloadChunked：单分片重试超限失败，清理已下载文件", async () => {
	const total = 8 * 1024 * 1024;
	const data = new Uint8Array(total);
	const fn = makeRequestFn(data, {
		// 第 2 片永远失败（maxRetries=3 次都失败）
		failures: { "bytes=5242880-8388607": 999 },
	});
	const { adapter, bytes } = makeMemoryAdapter();
	await assert.rejects(
		() => downloadChunked(fn, adapter, "https://example.com/x.zip", "/x.zip", {
			chunkSize: 5 * 1024 * 1024,
			maxRetries: 3,
			retryInterval: 0,
		}),
		/下载失败/,
		"重试超限应抛错",
	);
	// 已下载的第 1 片应被清理（remove 清空 bytes）
	assert.equal(bytes.length, 0, "失败后应清理已下载文件");
});

test("downloadChunked：HEAD 失败抛错", async () => {
	const total = 8 * 1024 * 1024;
	const data = new Uint8Array(total);
	const baseFn = makeRequestFn(data);
	// 覆盖 HEAD 为失败
	const failingHead: ChunkRequestFn = async (params) => {
		if (params.method === "HEAD") {
			return { status: 404, arrayBuffer: new ArrayBuffer(0), headers: {} };
		}
		return baseFn(params);
	};
	const { adapter } = makeMemoryAdapter();
	await assert.rejects(
		() => downloadChunked(failingHead, adapter, "https://example.com/x.zip", "/x.zip", {
			chunkSize: 5 * 1024 * 1024,
			maxRetries: 3,
			retryInterval: 0,
		}),
		/HEAD 失败/,
		"HEAD 失败应抛错",
	);
});
