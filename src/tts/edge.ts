/**
 * edge-tts 引擎：通过 edge-tts-universal 库调用微软 Edge 在线 TTS。
 *
 * edge-tts-universal 的 browser 入口使用浏览器原生 WebSocket 连接
 * wss://speech.platform.bing.com，内部封装了 DRM token / SSML / 音频帧解析。
 * WebSocket 不受 CORS 限制（与 fetch/XHR 不同），Obsidian 桌面/移动端均原生支持。
 */

import { Communicate } from "edge-tts-universal/browser";

/** 默认日文语音（女声） */
export const DEFAULT_EDGE_VOICE = "ja-JP-NanamiNeural";
/** 降级用的固定日文语音（语音列表拉取失败时用） */
export const FALLBACK_EDGE_VOICES = [
	"ja-JP-NanamiNeural",
	"ja-JP-KeitaNeural",
];

/** 语音列表条目（微软 voice list API 返回） */
export interface EdgeVoice {
	ShortName: string;
	FriendlyName: string;
	Locale: string;
	Gender: string;
}

/**
 * 把统一语速 ttsRate（1.0=正常）转为 edge SSML 的 rate 百分比字符串。
 * 1.0 → "+0%"，2.0 → "+100%"，0.5 → "-50%"。
 * edge-tts-universal 接受百分比字符串或数字，这里统一用百分比字符串。
 * edge 的 rate 建议范围 [-50%, +100%]，超出 clamp 并 console.warn。
 */
export function formatEdgeRate(ttsRate: number): string {
	let pct = Math.round((ttsRate - 1) * 100);
	if (pct < -50) {
		console.warn(`[nihong-ai-explain tts] edge rate ${pct}% 低于 -50%，clamp 到 -50%`);
		pct = -50;
	} else if (pct > 100) {
		console.warn(`[nihong-ai-explain tts] edge rate ${pct}% 高于 100%，clamp 到 100%`);
		pct = 100;
	}
	return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * 合成语音：用 edge-tts-universal 的 BrowserCommunicate 调用 Edge TTS，
 * 收集所有音频帧拼装成完整 mp3 的 ArrayBuffer。
 *
 * @param text 待合成文本
 * @param voice 语音短名（如 ja-JP-NanamiNeural）
 * @param rate rate 百分比字符串（来自 formatEdgeRate）
 * @param timeoutMs 超时毫秒，默认 10000（edge 连接失败时会较快报错）
 * @returns mp3 音频的 ArrayBuffer
 * @throws 连接失败 / 超时 / 未收到音频
 */
export async function synthesizeEdge(
	text: string,
	voice: string,
	rate: string,
	timeoutMs = 10000,
): Promise<ArrayBuffer> {
	const communicate = new Communicate(text, { voice, rate });

	const chunks: Uint8Array[] = [];
	let audioReceived = false;

	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error(`edge-tts 合成超时（${timeoutMs}ms），可能是网络无法连接 speech.platform.bing.com`)), timeoutMs);
	});

	const synth = (async (): Promise<ArrayBuffer> => {
		for await (const chunk of communicate.stream()) {
			if (chunk.type === "audio" && chunk.data) {
				const data = chunk.data as Uint8Array;
				if (data.length > 0) {
					audioReceived = true;
					// 复制一份（避免持有库内部的 buffer 引用）
					chunks.push(new Uint8Array(data));
				}
			}
		}
		if (!audioReceived) {
			throw new Error("edge-tts 未收到音频数据（可能是网络无法连接 speech.platform.bing.com，建议切回 Google 引擎）");
		}
		const total = chunks.reduce((s, c) => s + c.length, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			merged.set(c, offset);
			offset += c.length;
		}
		return merged.buffer;
	})();

	return Promise.race([synth, timeoutPromise]);
}
