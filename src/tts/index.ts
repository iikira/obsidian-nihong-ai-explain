import { Notice, requestUrl } from "obsidian";

const MAX_SEGMENT_CHARS = 200;
const SPLIT_PATTERNS = [
	/([。！？!?\.…])/,
	/([，,；;、])/,
	/([\s])/,
];

const TTS_CACHE_SIZE = 128;

let currentAudio: HTMLAudioElement | null = null;
let currentToken = 0;
let currentRate = 1.0;
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
	return new Promise((r) => setTimeout(r, ms));
}

function getCache(text: string): string | null {
	const url = ttsCache.get(text);
	if (url === undefined) {
		return null;
	}
	ttsCache.delete(text);
	ttsCache.set(text, url);
	return url;
}

function setCache(text: string, url: string): void {
	if (ttsCache.has(text)) {
		ttsCache.delete(text);
	}
	ttsCache.set(text, url);
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

export function setTTSRate(rate: number): void {
	currentRate = rate;
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
		return cached;
	}
	const url = buildTTSURL(text);
	const resp = await requestUrl({ url, method: "GET" });
	const blob = new Blob([resp.arrayBuffer], { type: "audio/mpeg" });
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
		} catch {
			if (token !== currentToken || failed) {
				return;
			}
			failed = true;
			new Notice(
				`朗读失败：无法获取 TTS 音频（第 ${idx + 1}/${chunks.length} 段）。请检查网络连接。`,
			);
			return;
		}
		if (token !== currentToken || failed) {
			return;
		}

		const audio = new Audio(blobUrl);
		audio.style.display = "none";
		audio.playbackRate = currentRate;
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
		} catch {
			if (token !== currentToken || failed) {
				return;
			}
			failed = true;
			audio.remove();
			if (currentAudio === audio) {
				currentAudio = null;
			}
			new Notice("朗读失败：浏览器拒绝自动播放");
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
				cleanup();
				if (token === currentToken && !failed) {
					failed = true;
					new Notice(
						`朗读失败：音频解码错误（第 ${idx + 1}/${chunks.length} 段）`,
					);
				}
				resolve();
			};
			audio.addEventListener("ended", onEnd);
			audio.addEventListener("error", onError);
		});
	}
}

