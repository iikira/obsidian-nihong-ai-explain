import { Notice, requestUrl } from "obsidian";
import { logInfo, logError, errMsg } from "../log";
import { emitCacheChange } from "../cacheEvents";
import { PersistentTTSCache, IndexedDBTTSCacheStorage, type TTSCacheStorage } from "./cache";
import {
	synthesizeWindows,
	isWindowsTTSAvailable,
	listWindowsVoices,
	probeWindowsTTSOnce,
} from "./windows";

export { isWindowsTTSAvailable, listWindowsVoices, probeWindowsTTSOnce };

const MAX_SEGMENT_CHARS = 200;
const SPLIT_PATTERNS = [
	/([。！？!?.…])/,
	/([，,；;、])/,
	/([\s])/,
];

const TTS_HEADERS = {
	Referer: "https://translate.google.com/",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/** TTS 引擎类型 */
export type TtsEngine = "google" | "windows";

/** TTS 配置：引擎、语音（windows 用）、语速（1.0=正常） */
export interface TtsConfig {
	engine: TtsEngine;
	/** windows 引擎的语音描述；google 忽略 */
	voice: string;
	/** 朗读语速倍率（0.5–3.0，1.0=正常） */
	rate: number;
	/** google 引擎的自定义域名（如 google-translate-vercel.roojay.com），空=官方域名 translate.google.com */
	googleDomain: string;
}

let currentAudio: HTMLAudioElement | null = null;
let currentToken = 0;
/** 当前段等待 Promise 的 resolve：stopSpeak() 打断时主动调用，避免 Promise 永不结算
 *  （pause()/remove() 不触发 ended/error，否则停在 line 294 的 await 会永久挂起） */
let currentResolver: (() => void) | null = null;
/** 当前 TTS 配置（引擎/语音/语速） */
let currentConfig: TtsConfig = { engine: "google", voice: "", rate: 1.0, googleDomain: "" };
/** TTS 朗读缓存：内存 blobUrl + IndexedDB 字节持久化（key = engine::voice::text），LRU 淘汰 */
const ttsCache = new PersistentTTSCache();

function splitForTTS(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) {
		return [];
	}
	const out: string[] = [];
	let rest = trimmed;
	while (rest.length > MAX_SEGMENT_CHARS) {
		let cut = -1;
		const slice = rest.slice(0, MAX_SEGMENT_CHARS);
		for (const pat of SPLIT_PATTERNS) {
			const m = slice.match(new RegExp(pat.source + ".*$"));
			if (m && m.index !== undefined) {
				const pos = m.index + m[0].length;
				if (pos > 0 && (cut === -1 || pos > cut)) {
					cut = pos;
				}
			}
		}
		if (cut <= 0) {
			cut = MAX_SEGMENT_CHARS;
		}
		out.push(rest.slice(0, cut));
		rest = rest.slice(cut).trimStart();
	}
	if (rest) {
		out.push(rest);
	}
	return out;
}

function buildTTSURL(text: string): string {
	const q = encodeURIComponent(text);
	// 自定义域名优先，去掉协议与末尾斜杠后拼接；空则用官方域名
	let domain = (currentConfig.googleDomain || "").trim();
	domain = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
	if (!domain) {
		domain = "translate.google.com";
	}
	return `https://${domain}/translate_tts?ie=UTF-8&q=${q}&tl=ja&client=tw-ob`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** 缓存 key 加引擎 + 语音前缀，防止 google / windows 不同语音同文本缓存串 */
function cacheKey(text: string): string {
	return `${currentConfig.engine}::${currentConfig.voice}::${text}`;
}

function getCache(text: string): string | null {
	const k = cacheKey(text);
	const url = ttsCache.get(k);
	if (url !== null) {
		// 命中缓存：LRU 提升后通知缓存视图刷新（顺序变化需反映）
		emitCacheChange("tts");
	}
	return url;
}

/** 写入缓存：存字节到持久层 + 建 blobUrl 到内存层；返回 blobUrl 供播放。LRU 淘汰两层同步 */
async function setCache(text: string, buffer: ArrayBuffer, mime?: string): Promise<string> {
	const k = cacheKey(text);
	const url = await ttsCache.set(k, buffer, mime);
	emitCacheChange("tts");
	return url;
}

/** 设置 TTS 配置（引擎/语音/语速），由设置页与 onload 调用 */
export function setTTSConfig(cfg: TtsConfig): void {
	currentConfig = cfg;
}

/** 兼容旧接口：仅设语速 */
export function setTTSRate(rate: number): void {
	currentConfig = { ...currentConfig, rate };
}

/**
 * 初始化 TTS 持久化缓存：注入 IndexedDB 适配器并从持久层加载重建 blobUrl。
 * 由 main.ts onload 调用。加载前 getCache 命中 null（调用方重新合成），加载后命中持久层。
 */
export async function initTTSCache(): Promise<void> {
	ttsCache.setStorage(new IndexedDBTTSCacheStorage());
	await ttsCache.load();
}

/** 测试用：注入自定义存储适配器（绕过 IndexedDB） */
export function setTTSCacheStorageForTest(storage: TTSCacheStorage): void {
	ttsCache.setStorage(storage);
}

/** 测试用：从持久层加载（注入存储后调用） */
export async function loadTTSCacheForTest(): Promise<void> {
	await ttsCache.load();
}

/** 清空 TTS 缓存：revoke 全部 blobUrl + 清内存 + 清持久层 */
export async function clearTTSCache(): Promise<void> {
	await ttsCache.clear();
	emitCacheChange("tts");
}

/** 关闭 TTS 缓存底层 DB 连接（插件卸载时调用，避免重载后升级被旧连接阻塞） */
export async function closeTTSCache(): Promise<void> {
	await ttsCache.close();
}

export function getTTSCacheSize(): number {
	return ttsCache.size();
}

/** TTS 缓存条目（供日志面板「朗读缓存」tab 展示 + 点击重播） */
export interface TTSCacheEntry {
	/** 原文 */
	text: string;
	/** 引擎 */
	engine: string;
	/** 语音（windows 用，google 为空） */
	voice: string;
	/** blob URL（点击直接播） */
	blobUrl: string;
}

/**
 * 返回当前 TTS 缓存所有条目，按最近使用在前（LRU 逆序）返回。
 * key 格式为 `engine::voice::text`，解析出三个字段。
 * 仅返回当前仍存活（未被 LRU 淘汰 revoke）的条目。
 */
export function getTTSCacheEntries(): TTSCacheEntry[] {
	// ttsCache.entries() 已按 LRU 逆序（最近使用在前）
	const entries: TTSCacheEntry[] = [];
	for (const { key, blobUrl } of ttsCache.entries()) {
		const sep1 = key.indexOf("::");
		const sep2 = key.indexOf("::", sep1 + 2);
		if (sep1 < 0 || sep2 < 0) {
			continue;
		}
		entries.push({
			engine: key.slice(0, sep1),
			voice: key.slice(sep1 + 2, sep2),
			text: key.slice(sep2 + 2),
			blobUrl,
		});
	}
	return entries;
}

/**
 * 直接播放一个已缓存的 TTS blob URL（日志面板「朗读缓存」点击重播用）。
 * 先打断当前朗读（stopSpeak），再 new Audio 播放该 blob。
 * 注意：blob URL 若已被 LRU 淘汰 revoke 则播放失败（列表只展示存活条目，故调用方应只用列表内的 blobUrl）。
 */
export function playTTSCacheBlob(blobUrl: string): void {
	stopSpeak();
	const audio = new Audio(blobUrl);
	audio.setCssStyles({ display: "none" });
	audio.playbackRate = currentConfig.engine === "google" ? currentConfig.rate : 1.0;
	currentAudio = audio;
	const token = ++currentToken;
	document.body.appendChild(audio);
	void audio.play().catch((err: unknown) => {
		logError("tts", `重播缓存 blob 失败: ${errMsg(err)}`);
	});
	// 播放结束清理（与 speakText 段等待一致：登记 resolver 供 stopSpeak 打断）
	audio.addEventListener("ended", () => {
		audio.remove();
		if (currentAudio === audio) {
			currentAudio = null;
		}
	});
	audio.addEventListener("error", () => {
		audio.remove();
		if (currentAudio === audio) {
			currentAudio = null;
		}
		if (token === currentToken) {
			new Notice("重播失败：音频数据无效或已失效");
		}
	});
}

/** 仅测试用：预置 TTS 缓存，使 fetchTTSBlob 命中缓存跳过 requestUrl。生产代码不应调用。
 *  seed 前需先 setTTSConfig 设好 engine/voice（cacheKey 以二者为前缀）。
 *  注意：持久化缓存存字节+建 blobUrl，故 seed 传字节（测试用任意非空 buffer 即可）。 */
export async function __seedTtsCacheForTest(text: string, buffer: ArrayBuffer): Promise<string> {
	return setCache(text, buffer);
}

async function fetchTTSBlob(text: string): Promise<string> {
	const cached = getCache(text);
	if (cached !== null) {
		return cached;
	}
	const engine = currentConfig.engine;
	let buf: ArrayBuffer;
	if (engine === "windows") {
		buf = await synthesizeWindows(text, currentConfig.rate, currentConfig.voice);
	} else {
		const url = buildTTSURL(text);
		const t0 = Date.now();
		const resp = await requestUrl({
			url,
			method: "GET",
			headers: TTS_HEADERS,
		});
		logInfo(
			"tts",
			`google 响应 status=${resp.status} byteLength=${resp.arrayBuffer?.byteLength} 耗时=${Date.now() - t0}ms`,
		);
		buf = resp.arrayBuffer;
	}
	if (!buf || buf.byteLength === 0) {
		throw new Error(`${engine} TTS 响应体为空`);
	}
	// 存字节到持久层 + 建 blobUrl 到内存层，返回 blobUrl 供播放
	const mime = engine === "windows" ? "audio/wav" : "audio/mpeg";
	const blobUrl = await setCache(text, buf, mime);
	return blobUrl;
}

export function isTTSAvailable(): boolean {
	return true;
}

export function stopSpeak(): void {
	currentToken++;
	// 先抓取并清空 resolver，再撕毁 audio，最后唤醒挂起的段等待 Promise。
	// pause()/remove() 不触发 ended/error，若不主动 resolve，停在 await 段等待的 Promise 会永久挂起，
	// 进而导致 main.ts 的 .finally(() => finishTask) 永不执行，tts 任务槽泄漏（「正在朗读中」无法再读）。
	const resolver = currentResolver;
	currentResolver = null;
	if (currentAudio) {
		try {
			currentAudio.pause();
		} catch {
			// noop
		}
		currentAudio.remove();
		currentAudio = null;
	}
	// 唤醒旧段等待的 Promise：其循环下一轮撞上 token !== currentToken 后 return，外层 Promise 结算
	resolver?.();
}

export async function speakText(text: string): Promise<void> {
	const clean = text.trim();
	if (!clean) {
		new Notice("选区为空");
		return;
	}
	stopSpeak();
	const token = ++currentToken;
	const chunks = splitForTTS(clean);
	let started = false;
	let failed = false;

	for (let idx = 0; idx < chunks.length; idx++) {
		if (token !== currentToken || failed) {
			return;
		}
		if (idx > 0) {
			await sleep(200);
		}
		if (token !== currentToken || failed) {
			return;
		}

		let blobUrl: string;
		try {
			blobUrl = await fetchTTSBlob(chunks[idx]);
		} catch (err) {
			logError(
				"nihong-ai-explain tts",
				`fetchTTSBlob 失败（第 ${idx + 1}/${chunks.length} 段）: ${errMsg(err)}`,
			);
			if (token !== currentToken || failed) {
				return;
			}
			failed = true;
			const noticeMsg = errMsg(err);
			new Notice(`朗读失败：${noticeMsg}`);
			return;
		}
		if (token !== currentToken || failed) {
			return;
		}

		const audio = new Audio(blobUrl);
		audio.setCssStyles({ display: "none" });
		// 语速处理：google 用 playbackRate；windows 已在合成端设了 rate，这里不再叠加避免双重变速
		audio.playbackRate = currentConfig.engine === "google" ? currentConfig.rate : 1.0;
		currentAudio = audio;

		if (!started) {
			started = true;
			new Notice(
				`朗读：${clean.length > 30 ? clean.slice(0, 30) + "…" : clean}`,
			);
		}
		document.body.appendChild(audio);

		try {
			await audio.play();
		} catch (err) {
			logError("tts", `audio.play() 失败: ${errMsg(err)}`);
			if (token !== currentToken || failed) {
				return;
			}
			failed = true;
			audio.remove();
			if (currentAudio === audio) {
				currentAudio = null;
			}
			// 按 DOMException 名称区分：自动播放策略拦截 vs 音频源不支持
			const errName = err instanceof DOMException ? err.name : "";
			let msg: string;
			if (errName === "NotAllowedError") {
				msg = "朗读失败：浏览器拒绝自动播放";
			} else if (errName === "NotSupportedError") {
				msg = "朗读失败：音频格式不支持或数据无效";
			} else {
				msg = `朗读失败：${err instanceof Error ? err.message : String(err)}`;
			}
			new Notice(msg);
			return;
		}

		await new Promise<void>((resolve) => {
			// 登记 resolve：stopSpeak() 打断时调用它唤醒此等待，否则 pause()/remove() 不触发事件会永久挂起
			currentResolver = resolve;
			const cleanup = (): void => {
				currentResolver = null;
				audio.removeEventListener("ended", onEnd);
				audio.removeEventListener("error", onError);
				audio.remove();
				if (currentAudio === audio) {
					currentAudio = null;
				}
			};
			const onEnd = (): void => {
				cleanup();
				resolve();
			};
			const onError = (): void => {
				logError(
					"nihong-ai-explain tts",
					`audio error 事件 code=${audio.error?.code}`,
				);
				cleanup();
				if (token === currentToken && !failed) {
					failed = true;
					new Notice(
						`朗读失败：音频解码错误（第 ${idx + 1}/${chunks.length} 段，code=${audio.error?.code}）`,
					);
				}
				resolve();
			};
			audio.addEventListener("ended", onEnd);
			audio.addEventListener("error", onError);
		});
	}
}

