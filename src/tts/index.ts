import { Notice } from "obsidian";

const MAX_SEGMENT_CHARS = 200;
const SPLIT_PATTERNS = [
	/([。！？!?\.…])/,
	/([，,；;、])/,
	/([\s])/,
];

let currentAudio: HTMLAudioElement | null = null;
let currentToken = 0;

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
		currentAudio.src = "";
		currentAudio.removeAttribute("src");
		currentAudio.load?.();
		currentAudio.remove();
		currentAudio = null;
	}
}

export function speakText(text: string): void {
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

	const playChunk = (idx: number): void => {
		if (token !== currentToken || idx >= chunks.length || failed) {
			return;
		}
		const url = buildTTSURL(chunks[idx]);
		const audio = document.createElement("audio");
		audio.style.display = "none";
		audio.preload = "auto";
		audio.crossOrigin = "anonymous";
		audio.src = url;
		currentAudio = audio;

		audio.addEventListener("ended", () => {
			if (token !== currentToken || failed) {
				return;
			}
			audio.remove();
			if (currentAudio === audio) {
				currentAudio = null;
			}
			playChunk(idx + 1);
		});
		audio.addEventListener("error", () => {
			if (token !== currentToken) {
				return;
			}
			if (failed) {
				return;
			}
			failed = true;
			audio.remove();
			if (currentAudio === audio) {
				currentAudio = null;
			}
			new Notice(
				`朗读失败：无法获取 TTS 音频（第 ${idx + 1}/${chunks.length} 段）。请检查网络连接。`,
			);
		});

		if (!started) {
			started = true;
			new Notice(
				`朗读：${clean.length > 30 ? clean.slice(0, 30) + "…" : clean}`,
			);
		}

		document.body.appendChild(audio);
		const playPromise = audio.play();
		if (playPromise && typeof playPromise.catch === "function") {
			playPromise.catch(() => {
				if (token !== currentToken || failed) {
					return;
				}
				failed = true;
				audio.remove();
				if (currentAudio === audio) {
					currentAudio = null;
				}
				new Notice("朗读失败：浏览器拒绝自动播放音频");
			});
		}
	};

	playChunk(0);
}
