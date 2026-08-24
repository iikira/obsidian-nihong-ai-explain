import { Notice } from "obsidian";

const MAX_UTTERANCE_CHARS = 1800;
const SPLIT_PATTERNS = [
	/([。！？!?])/,
	/([，,；;])/,
	/([、\s])/,
];

function splitForTTS(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_UTTERANCE_CHARS) {
		return trimmed ? [trimmed] : [];
	}
	const out: string[] = [];
	let rest = trimmed;
	while (rest.length > MAX_UTTERANCE_CHARS) {
		let cut = -1;
		for (const pat of SPLIT_PATTERNS) {
			const slice = rest.slice(0, MAX_UTTERANCE_CHARS);
			const m = slice.match(new RegExp(pat.source + ".*$"));
			if (m && m.index !== undefined) {
				const pos = m.index + m[0].length;
				if (pos > 0 && (cut === -1 || pos > cut)) {
					cut = pos;
				}
			}
		}
		if (cut <= 0) {
			out.push(rest.slice(0, MAX_UTTERANCE_CHARS));
			rest = rest.slice(MAX_UTTERANCE_CHARS);
		} else {
			out.push(rest.slice(0, cut));
			rest = rest.slice(cut);
		}
		rest = rest.trimStart();
	}
	if (rest) {
		out.push(rest);
	}
	return out;
}

let currentToken = 0;

export function isTTSAvailable(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.speechSynthesis !== "undefined" &&
		typeof window.SpeechSynthesisUtterance !== "undefined"
	);
}

export function stopSpeak(): void {
	if (!isTTSAvailable()) {
		return;
	}
	currentToken++;
	try {
		window.speechSynthesis.cancel();
	} catch {
		// noop
	}
}

export function speakText(text: string): void {
	if (!isTTSAvailable()) {
		new Notice("当前环境不支持语音合成");
		return;
	}
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

	const speakChunk = (idx: number): void => {
		if (token !== currentToken || idx >= chunks.length) {
			return;
		}
		const utter = new SpeechSynthesisUtterance(chunks[idx]);
		utter.lang = "ja-JP";
		utter.rate = 1;
		utter.pitch = 1;
		utter.volume = 1;
		utter.onend = () => {
			if (token !== currentToken || failed) {
				return;
			}
			speakChunk(idx + 1);
		};
		utter.onerror = (ev: SpeechSynthesisErrorEvent) => {
			if (token !== currentToken) {
				return;
			}
			const err = ev?.error || "";
			if (err === "interrupted" || err === "canceled") {
				return;
			}
			failed = true;
			new Notice(`朗读失败：${err || "未知错误"}。请检查系统 TTS 引擎及日语语音包。`);
		};
		if (!started) {
			started = true;
			new Notice(`朗读：${clean.length > 30 ? clean.slice(0, 30) + "…" : clean}`);
		}
		try {
			window.speechSynthesis.speak(utter);
		} catch {
			if (token === currentToken && !failed) {
				failed = true;
				new Notice("朗读调用异常");
			}
		}
	};
	speakChunk(0);
}
