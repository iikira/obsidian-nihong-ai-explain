// 测「play 失败 / error 不写缓存，play 成功（ended）才写缓存」：
//   fetchTTSBlob 不再立即写缓存，改返回 { url, buffer }；speakText 在 onEnd 才 setCache，
//   play catch / onError 时回收临时 blobUrl 且不写。避免 google 返非空无效音频污染缓存。
//
// 关键：fetchTTSBlob 命中缓存时 buffer=null（speakText 据此跳过写/回收）；未命中时建临时 blobUrl
// 并返回 buffer。obsidian 桩的 requestUrl 固定返空字节（无法覆盖「非空无效」路径），故用 setRequestFnForTest
// 注入 mock requestFn 返非空无效字节（HTML 字节，非 MPEG）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	speakText,
	stopSpeak,
	setTTSConfig,
	setRequestFnForTest,
	clearTTSCache,
	getTTSCacheSize,
	getTTSCacheEntries,
} from "../src/tts/index.ts";

type NoticeCtor = new (...args: unknown[]) => unknown;
type AudioCtor = new (src?: string) => unknown;

interface FakeAudio {
	playbackRate: number;
	listeners: Map<string, Set<(ev: unknown) => void>>;
	removed: boolean;
	playResult: "resolve" | "reject";
	play(): Promise<void>;
	pause(): void;
	remove(): void;
	setCssStyles(_styles: Partial<CSSStyleDeclaration>): void;
	addEventListener(type: string, cb: (ev: unknown) => void): void;
	removeEventListener(type: string, cb: (ev: unknown) => void): void;
	dispatch(type: string): void;
}

/** 建假 audio：playResult 控制 play() resolve 还是 reject（reject 模拟 NotSupportedError） */
function makeFakeAudio(playResult: "resolve" | "reject"): FakeAudio {
	const listeners = new Map<string, Set<(ev: unknown) => void>>();
	return {
		playbackRate: 1,
		listeners,
		removed: false,
		playResult,
		play() {
			if (this.playResult === "reject") {
				const err = new DOMException("不支持", "NotSupportedError");
				return Promise.reject(err);
			}
			return Promise.resolve();
		},
		pause() {},
		remove() {
			this.removed = true;
		},
		setCssStyles() {},
		addEventListener(type, cb) {
			let set = listeners.get(type);
			if (!set) {
				set = new Set();
				listeners.set(type, set);
			}
			set.add(cb);
		},
		removeEventListener(type, cb) {
			listeners.get(type)?.delete(cb);
		},
		dispatch(type) {
			for (const cb of listeners.get(type) ?? []) {
				cb({});
			}
		},
	};
}

/** 控制后续 new Audio() 的 play 行为；speakText 每段会 new Audio，故用可变全局 + 工厂闭包 */
let playResultMode: "resolve" | "reject";
let lastFakeAudio: FakeAudio | null;

let savedWindow: typeof globalThis.window | undefined;
let savedAudio: AudioCtor | undefined;
let savedNotice: NoticeCtor | undefined;
let savedDocument: { body: { appendChild: (node: unknown) => unknown } } | undefined;
let savedRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
let savedCreateObjectURL: typeof URL.createObjectURL | undefined;

/** 记录 createObjectURL / revokeObjectURL 调用，供断言临时 blobUrl 是否被回收 */
let createdUrls: string[];
let revokedUrls: string[];

beforeEach(() => {
	savedWindow = (globalThis as { window?: typeof globalThis.window }).window;
	savedAudio = (globalThis as { Audio?: AudioCtor }).Audio;
	savedNotice = (globalThis as { Notice?: NoticeCtor }).Notice;
	savedDocument = (globalThis as { document?: typeof savedDocument }).document;
	savedRevokeObjectURL = (url: string) => URL.revokeObjectURL(url);
	savedCreateObjectURL = (obj: unknown) => URL.createObjectURL(obj);
	lastFakeAudio = null;
	playResultMode = "resolve";
	createdUrls = [];
	revokedUrls = [];

	(globalThis as { window: typeof globalThis.window }).window = {
		setTimeout: ((cb: (...args: unknown[]) => void, _ms?: number) => {
			cb();
			return 0 as unknown as number;
		}) as unknown as typeof window.setTimeout,
		clearTimeout: () => {},
	} as typeof globalThis.window;

	(globalThis as { Audio: AudioCtor }).Audio = function () {
		const a = makeFakeAudio(playResultMode);
		lastFakeAudio = a;
		return a;
	} as AudioCtor;

	(globalThis as { Notice: NoticeCtor }).Notice = class Notice {
		constructor() {}
	};

	(globalThis as { document: typeof savedDocument }).document = {
		body: { appendChild: () => {} },
	};

	// 拦截 URL.createObjectURL/revokeObjectURL：返伪 url 入 createdUrls；revoke 入 revokedUrls
	// 注意：缓存命中的 url 来自 ttsCache（也是 createObjectURL 造的），会被记录但不影响断言逻辑
	const urlCounter = { n: 0 };
	URL.createObjectURL = (_obj: unknown) => {
		urlCounter.n += 1;
		const u = `blob:test-${urlCounter.n}`;
		createdUrls.push(u);
		return u;
	};
	URL.revokeObjectURL = (u: string) => {
		revokedUrls.push(u);
	};

	stopSpeak();
	setTTSConfig({ engine: "google", voice: "", rate: 1.0, googleDomain: "" });
});

afterEach(async () => {
	stopSpeak();
	// 恢复默认 requestFn：返空字节（afterEach 不再调 speakText，仅复位）
	setRequestFnForTest(() =>
		Promise.resolve({ status: 200, arrayBuffer: new ArrayBuffer(0) }),
	);
	await clearTTSCache();
	if (savedWindow === undefined) {
		delete (globalThis as { window?: typeof globalThis.window }).window;
	} else {
		(globalThis as { window: typeof globalThis.window }).window = savedWindow;
	}
	if (savedAudio === undefined) {
		delete (globalThis as { Audio?: AudioCtor }).Audio;
	} else {
		(globalThis as { Audio: AudioCtor }).Audio = savedAudio;
	}
	if (savedNotice === undefined) {
		delete (globalThis as { Notice?: NoticeCtor }).Notice;
	} else {
		(globalThis as { Notice: NoticeCtor }).Notice = savedNotice;
	}
	if (savedDocument === undefined) {
		delete (globalThis as { document?: typeof savedDocument }).document;
	} else {
		(globalThis as { document: typeof savedDocument }).document = savedDocument;
	}
	URL.revokeObjectURL = savedRevokeObjectURL!;
	URL.createObjectURL = savedCreateObjectURL!;
});

/** 注入 mock requestFn 返非空无效字节（HTML 字节，非 MPEG 音频） */
function injectInvalidAudioRequest(): void {
	setRequestFnForTest(() =>
		Promise.resolve({
			status: 200,
			arrayBuffer: new TextEncoder().encode("<html>error</html>").buffer,
		}),
	);
}

/** 注入 mock requestFn 返有效字节（非空即可，play 成败由 playResultMode 决定） */
function injectValidAudioRequest(): void {
	setRequestFnForTest(() =>
		Promise.resolve({
			status: 200,
			arrayBuffer: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]).buffer,
		}),
	);
}

/** 让出微任务，让 speakText 跑到段等待 await */
async function tickToWait(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function rejectAfter(ms: number): Promise<never> {
	return new Promise((_resolve, reject) => {
		setTimeout(() => reject(new Error(`超时 ${ms}ms 未结算`)), ms);
	});
}

test("play() 失败：不写缓存（getTTSCacheSize 不增）", async () => {
	assert.equal(getTTSCacheSize(), 0);
	injectInvalidAudioRequest();
	playResultMode = "reject"; // play() reject → NotSupportedError
	const p = speakText("テスト");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
	// play 失败 → 不写缓存
	assert.equal(getTTSCacheSize(), 0, "play 失败不应写缓存");
	assert.deepEqual(
		getTTSCacheEntries().map((e) => e.text),
		[],
		"play 失败后缓存条目应为空",
	);
});

test("play() 失败：临时 blobUrl 被回收", async () => {
	injectInvalidAudioRequest();
	playResultMode = "reject";
	const before = createdUrls.length;
	const p = speakText("テスト");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
	// play 失败路径：fetchTTSBlob 建的临时 blobUrl 应被 revoke
	const newUrls = createdUrls.slice(before);
	assert.ok(newUrls.length > 0, "fetchTTSBlob 应建临时 blobUrl");
	for (const u of newUrls) {
		assert.ok(revokedUrls.includes(u), `临时 blobUrl ${u} 应被回收`);
	}
});

test("error 事件：不写缓存（getTTSCacheSize 不增）", async () => {
	assert.equal(getTTSCacheSize(), 0);
	injectValidAudioRequest();
	playResultMode = "resolve"; // play() 成功，但后续 dispatch error
	const p = speakText("テスト");
	await tickToWait();
	// play 成功后进段等待，手动 dispatch error → 模拟解码中途失败
	lastFakeAudio?.dispatch("error");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
	// error 事件 → 不写缓存
	assert.equal(getTTSCacheSize(), 0, "error 事件不应写缓存");
});

test("ended 事件：play 成功整段播完才写缓存", async () => {
	assert.equal(getTTSCacheSize(), 0);
	injectValidAudioRequest();
	playResultMode = "resolve";
	const p = speakText("テスト");
	await tickToWait();
	lastFakeAudio?.dispatch("ended"); // 整段自然播完 → 写缓存
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
	// ended → 写缓存
	assert.equal(getTTSCacheSize(), 1, "ended 应写缓存");
	assert.deepEqual(
		getTTSCacheEntries().map((e) => e.text),
		["テスト"],
	);
});

test("ended 后临时 blobUrl 被回收（setCache 写完后回收）", async () => {
	injectValidAudioRequest();
	playResultMode = "resolve";
	const before = createdUrls.length;
	const p = speakText("テスト");
	await tickToWait();
	lastFakeAudio?.dispatch("ended");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
	// fetchTTSBlob 建的临时 blobUrl（createdUrls[before]）应在 setCache 写完后被回收
	const tempUrl = createdUrls[before];
	assert.ok(tempUrl, "应有临时 blobUrl");
	assert.ok(revokedUrls.includes(tempUrl), "临时 blobUrl 应在 ended 写缓存后被回收");
});

test("命中缓存时 play 失败：不重复写、不回收缓存 url", async () => {
	// 先用 ended 路径写入缓存
	injectValidAudioRequest();
	playResultMode = "resolve";
	const p1 = speakText("テスト");
	await tickToWait();
	lastFakeAudio?.dispatch("ended"); // 整段播完 → 写缓存
	await assert.doesNotReject(Promise.race([p1, rejectAfter(2000)]), /超时/);
	assert.equal(getTTSCacheSize(), 1);

	// 第二次：同文本命中缓存（buffer=null），play 失败 → 不应清空/回收缓存
	playResultMode = "reject";
	const beforeRevoke = revokedUrls.length;
	const p2 = speakText("テスト");
	await assert.doesNotReject(Promise.race([p2, rejectAfter(2000)]), /超时/);
	assert.equal(getTTSCacheSize(), 1, "命中缓存时 play 失败不应清缓存");
	// 命中缓存路径不建临时 blobUrl，故不应有新 revoke
	assert.equal(revokedUrls.length, beforeRevoke, "命中缓存不应回收缓存 url");
});
