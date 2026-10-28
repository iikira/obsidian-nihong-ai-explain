// 测 TTS 打断时的状态泄漏修复：
//   复现：speakText(A) 播放中 → speakText(B) 打断 → 再 speakText(A) 永远提示「正在朗读中」。
//   根因：stopSpeak() 调 pause()+remove() 撕毁 audio，但不触发 ended/error，
//         speakText 卡在「等 ended/error」的 await 永不结算 → main.ts 的 .finally 永不执行 → 任务槽泄漏。
//   修复：stopSpeak() 主动调用段等待 Promise 的 resolve（currentResolver），让循环下一轮撞 token 检查后 return。
//
// 测试通过 mock globalThis.Audio（假 audio，play() 不派发事件，需测试手动 dispatch）+ 预置 TTS 缓存
// （跳过 requestUrl，obsidian 在测试环境是空模块）覆盖：打断结算、自然结束结算、连续打断结算。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	speakText,
	stopSpeak,
	setTTSConfig,
	__seedTtsCacheForTest,
} from "../src/tts/index.ts";

// --- 全局 mock：window / Audio / Notice / document（index.ts 依赖） ---
// 这些是浏览器/Obsidian 全局，Node 测试环境没有；用显式类型而非 typeof globalThis.X（后者解析为 any）。
type NoticeCtor = new (...args: unknown[]) => unknown;
type AudioCtor = new (src?: string) => unknown;

let savedWindow: typeof globalThis.window | undefined;
let savedAudio: AudioCtor | undefined;
let savedNotice: NoticeCtor | undefined;
let savedDocument: { body: { appendChild: (node: unknown) => unknown } } | undefined;

/** 假 audio：记录事件监听器，供测试手动 dispatch ended/error；play() resolved 但不派发事件 */
interface FakeAudio {
	playbackRate: number;
	removed: boolean;
	paused: boolean;
	listeners: Map<string, Set<(ev: unknown) => void>>;
	play(): Promise<void>;
	pause(): void;
	remove(): void;
	setCssStyles(_styles: Partial<CSSStyleDeclaration>): void;
	addEventListener(type: string, cb: (ev: unknown) => void): void;
	removeEventListener(type: string, cb: (ev: unknown) => void): void;
	dispatch(type: string): void;
}

function makeFakeAudio(): FakeAudio {
	const listeners = new Map<string, Set<(ev: unknown) => void>>();
	return {
		playbackRate: 1,
		removed: false,
		paused: false,
		listeners,
		play() {
			return Promise.resolve();
		},
		pause() {
			this.paused = true;
		},
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

/** 最近一次 new Audio() 创建的假 audio 实例（供测试手动 dispatch ended/error） */
let lastFakeAudio: FakeAudio | null = null;

beforeEach(() => {
	savedWindow = (globalThis as { window?: typeof globalThis.window }).window;
	savedAudio = (globalThis as { Audio?: AudioCtor }).Audio;
	savedNotice = (globalThis as { Notice?: NoticeCtor }).Notice;
	savedDocument = (globalThis as { document?: typeof savedDocument }).document;
	lastFakeAudio = null;
	(globalThis as { window: typeof globalThis.window }).window = {
		setTimeout: ((cb: (...args: unknown[]) => void, _ms?: number) => {
			// 测试用立即执行 timer，让 sleep(200) 不真实等待
			cb();
			return 0 as unknown as number;
		}) as unknown as typeof window.setTimeout,
		clearTimeout: () => {},
	} as typeof globalThis.window;
	(globalThis as { Audio: AudioCtor }).Audio = function () {
		const a = makeFakeAudio();
		lastFakeAudio = a;
		return a;
	} as AudioCtor;
	(globalThis as { Notice: NoticeCtor }).Notice = class Notice {
		constructor() {}
	};
	// index.ts:282 document.body.appendChild(audio) —— Node 无 document，桩一个最小 body
	(globalThis as { document: typeof savedDocument }).document = {
		body: { appendChild: () => {} },
	};
	// 重置 TTS 模块状态（清 currentAudio/currentResolver/currentToken）
	stopSpeak();
	setTTSConfig({ engine: "google", voice: "", rate: 1.0, googleDomain: "" });
});

afterEach(() => {
	stopSpeak();
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
});

/** 让出若干微任务，让 speakText 跑到段等待 await（play() 已 resolve，进入等 ended/error） */
async function tickToWait(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

/** 超时拒绝：若 Promise 在 ms 内未结算则 reject（用于断言「不该挂起」） */
function rejectAfter(ms: number): Promise<never> {
	return new Promise((_resolve, reject) => {
		setTimeout(() => reject(new Error(`超时 ${ms}ms 未结算`)), ms);
	});
}

test("打断结算：speakText(A) 播放中 stopSpeak() 后 Promise 应结算（不挂起）", async () => {
	await __seedTtsCacheForTest("A", new ArrayBuffer(8));
	const p = speakText("A");
	await tickToWait();
	// 打断（不派发任何 audio 事件），应通过 currentResolver 唤醒段等待
	stopSpeak();
	// 修复前：p 永不结算 → 超时失败；修复后：p 立即 resolve
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
});

test("自然结束结算：dispatch('ended') 后 Promise 应结算", async () => {
	await __seedTtsCacheForTest("C", new ArrayBuffer(8));
	const p = speakText("C");
	await tickToWait();
	// 手动派发 ended（模拟自然播放结束）——验证 ended 路径未因新增 currentResolver 逻辑破坏
	lastFakeAudio?.dispatch("ended");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
});

test("连续打断结算：speakText(A) → speakText(B) 两个 Promise 均结算", async () => {
	await __seedTtsCacheForTest("A", new ArrayBuffer(8));
	await __seedTtsCacheForTest("B", new ArrayBuffer(8));
	const pa = speakText("A");
	await tickToWait();
	const pb = speakText("B"); // 内部 stopSpeak() 打断 A
	await tickToWait();
	stopSpeak(); // 再打断 B
	await assert.doesNotReject(Promise.race([pa, rejectAfter(2000)]), /超时/);
	await assert.doesNotReject(Promise.race([pb, rejectAfter(2000)]), /超时/);
});

test("error 路径结算：dispatch('error') 后 Promise 应结算不抛", async () => {
	await __seedTtsCacheForTest("E", new ArrayBuffer(8));
	const p = speakText("E");
	await tickToWait();
	// 手动派发 error（音频解码错误路径）——onError 内 cleanup+resolve
	lastFakeAudio?.dispatch("error");
	await assert.doesNotReject(Promise.race([p, rejectAfter(2000)]), /超时/);
});
