import { Notice, requestUrl } from "obsidian";
import { synthesizeEdge, formatEdgeRate } from "./edge";

const MAX_SEGMENT_CHARS = 200;
const SPLIT_PATTERNS = [
	/([。！？!?.…])/,
	/([，,；;、])/,
	/([\s])/,
];

const TTS_CACHE_SIZE = 128;

const TTS_HEADERS = {
	Referer: "https://translate.google.com/",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/** TTS 引擎类型 */
export type TtsEngine = "google" | "edge";

/** TTS 配置：引擎、语音（edge 用）、语速（1.0=正常） */
export interface TtsConfig {
	engine: TtsEngine;
	/** edge 引擎的语音短名（如 ja-JP-NanamiNeural）；google 忽略 */
	voice: string;
	/** 朗读语速倍率（0.5–3.0，1.0=正常） */
	rate: number;
}

let currentAudio: HTMLAudioElement | null = null;
let currentToken = 0;
/** 当前 TTS 配置（引擎/语音/语速） */
let currentConfig: TtsConfig = { engine: "google", voice: "", rate: 1.0 };
const ttsCache = new Map<string, string>();

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
	return `https://translate.google.com/translate_tts?ie=UTF-8&q=${q}&tl=ja&client=tw-ob`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** 缓存 key 加引擎前缀，防止 google / edge 同文本缓存串 */
function cacheKey(text: string): string {
	return `${currentConfig.engine}::${text}`;
}

function getCache(text: string): string | null {
	const k = cacheKey(text);
	const url = ttsCache.get(k);
	if (url === undefined) {
		return null;
	}
	ttsCache.delete(k);
	ttsCache.set(k, url);
	return url;
}

function setCache(text: string, url: string): void {
	const k = cacheKey(text);
	if (ttsCache.has(k)) {
		ttsCache.delete(k);
	}
	ttsCache.set(k, url);
	while (ttsCache.size > TTS_CACHE_SIZE) {
		const firstKey = ttsCache.keys().next().value;
		if (firstKey === undefined) {
			break;
		}
		const oldUrl = ttsCache.get(firstKey);
		if (oldUrl) {
			URL.revokeObjectURL(oldUrl);
		}
		ttsCache.delete(firstKey);
	}
}

/** 设置 TTS 配置（引擎/语音/语速），由设置页与 onload 调用 */
export function setTTSConfig(cfg: TtsConfig): void {
	currentConfig = cfg;
}

/** 兼容旧接口：仅设语速 */
export function setTTSRate(rate: number): void {
	currentConfig = { ...currentConfig, rate };
}

export function clearTTSCache(): void {
	for (const url of ttsCache.values()) {
		URL.revokeObjectURL(url);
	}
	ttsCache.clear();
}

export function getTTSCacheSize(): number {
	return ttsCache.size;
}

async function fetchTTSBlob(text: string): Promise<string> {
	const cached = getCache(text);
	if (cached !== null) {
		console.log(
			"[nihong-ai-explain tts] 缓存命中",
			text.slice(0, 30),
		);
		return cached;
	}
	const engine = currentConfig.engine;
	let buf: ArrayBuffer;
	if (engine === "edge") {
		console.log("[nihong-ai-explain tts] edge 引擎请求", text.slice(0, 30));
		buf = await synthesizeEdge(
			text,
			currentConfig.voice,
			formatEdgeRate(currentConfig.rate),
		);
	} else {
		const url = buildTTSURL(text);
		console.log("[nihong-ai-explain tts] google 引擎请求 URL", url);
		const resp = await requestUrl({
			url,
			method: "GET",
			headers: TTS_HEADERS,
		});
		console.log(
			"[nihong-ai-explain tts] google 响应 status=",
			resp.status,
			"byteLength=",
			resp.arrayBuffer?.byteLength,
		);
		buf = resp.arrayBuffer;
	}
	if (!buf || buf.byteLength === 0) {
		throw new Error(`${engine} TTS 响应体为空`);
	}
	const blob = new Blob([buf], { type: "audio/mpeg" });
	const blobUrl = URL.createObjectURL(blob);
	setCache(text, blobUrl);
	return blobUrl;
}

export function isTTSAvailable(): boolean {
	return true;
}

export function stopSpeak(): void {
	currentToken++;
	if (currentAudio) {
		try {
			currentAudio.pause();
		} catch {
			// noop
		}
		currentAudio.remove();
		currentAudio = null;
	}
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
			console.error(
				`[nihong-ai-explain tts] fetchTTSBlob 失败（第 ${idx + 1}/${chunks.length} 段）`,
				err,
			);
			if (token !== currentToken || failed) {
				return;
			}
			failed = true;
			const errMsg = err instanceof Error ? err.message : String(err);
			new Notice(`朗读失败：${errMsg}`);
			return;
		}
		if (token !== currentToken || failed) {
			return;
		}

		const audio = new Audio(blobUrl);
		audio.setCssStyles({ display: "none" });
		// 语速处理：google 用 playbackRate；edge 已在 SSML 里设了 rate，这里不再叠加避免双重变速
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
			console.error("[nihong-ai-explain tts] audio.play() 失败", err);
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
			const cleanup = (): void => {
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
				console.error(
					"[nihong-ai-explain tts] audio error 事件",
					audio.error,
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

