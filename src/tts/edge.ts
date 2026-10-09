/**
 * edge-tts 引擎：参考 rany2/edge-tts Python 库的 WebSocket 协议实现。
 *
 * 微软 Edge 在线 TTS 通过 wss://speech.platform.bing.com 的 WebSocket 服务合成语音：
 * 1. 建连：wss URL 带 TrustedClientToken / ConnectionId / Sec-MS-GEC（DRM token）/ Sec-MS-GEC-Version
 * 2. 发两条文本帧：speech.config（指定输出格式）+ ssml（SSML 合成请求）
 * 3. 收帧：binary 帧含 mp3 数据（前 2 字节是 header 长度，跳过 header 取数据），
 *    text 帧含 Path 标记（turn.end 表示合成结束）
 *
 * WebSocket 不受 CORS 限制（与 fetch/XHR 不同），Obsidian 桌面 Electron / 移动 Capacitor 均原生支持。
 */

/** Windows 文件时间纪元偏移（1601-01-01 与 1970-01-01 的秒数差） */
const WIN_EPOCH = 11644473600;
/** 微软 Edge TTS 可信客户端令牌 */
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
/** Chromium 完整版本号（用于 Sec-MS-GEC-Version） */
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
/** 语音列表 API */
export const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
/** WSS 连接请求头 */
const WSS_HEADERS: Record<string, string> = {
	"Origin": "chrome-extension://jdiccigimpmpgghjlcchfojbdhlfmlhi",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
	"Sec-CH-UA": `" Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"`,
};

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
 * 生成 Sec-MS-GEC（DRM token）：
 * 取当前 Unix 时间戳（秒）→ 加 Windows 纪元偏移 → 向下取整到 5 分钟（300 秒）
 * → 转 100ns 间隔（×1e7）→ SHA256(时间戳 + TRUSTED_CLIENT_TOKEN) 的大写 hex。
 *
 * @param unixTimestamp Unix 时间戳（秒），默认取当前时间；参数化便于单测。
 */
export function generateSecMsGec(unixTimestamp: number = Date.now() / 1000): string {
	let ticks = unixTimestamp + WIN_EPOCH;
	// 向下取整到最近的 5 分钟（300 秒）
	ticks -= ticks % 300;
	// 转为 100 纳秒间隔（Windows 文件时间格式）
	ticks *= 1e7;
	const strToHash = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
	// SHA256 → 大写 hex
	return sha256Hex(strToHash).toUpperCase();
}

/**
 * 生成 ConnectionId（32 位无连字符的 hex，类似 UUID 去掉横线）。
 */
export function generateConnectId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * 把统一语速 ttsRate（1.0=正常）转为 edge SSML 的 rate 百分比字符串。
 * 1.0 → "+0%"，2.0 → "+100%"，0.5 → "-50%"。
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

/** 转义 XML 特殊字符（& < > " '） */
function escapeXML(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 构建 SSML 请求体。
 * @param text 待合成文本（会做 XML 转义）
 * @param voice 语音短名（如 ja-JP-NanamiNeural）
 * @param rate rate 百分比字符串（如 "+0%"，来自 formatEdgeRate）
 * @param pitch 音高（默认 "+0Hz"）
 * @param volume 音量（默认 "+0%"）
 */
export function buildSSML(
	text: string,
	voice: string,
	rate: string,
	pitch = "+0Hz",
	volume = "+0%",
): string {
	const escaped = escapeXML(text);
	return (
		"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
		`<voice name='${escapeXML(voice)}'>` +
		`<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
		`${escaped}` +
		"</prosody>" +
		"</voice>" +
		"</speak>"
	);
}

/** JavaScript 风格的时间戳字符串（如 "Thu Oct 09 2026 12:00:00 GMT+0000 (Coordinated Universal Time)"） */
function dateToString(): string {
	return new Date().toString();
}

/** 拼装 speech.config 文本帧 */
function buildConfigMessage(): string {
	return (
		`X-Timestamp:${dateToString()}\r\n` +
		"Content-Type:application/json; charset=utf-8\r\n" +
		"Path:speech.config\r\n\r\n" +
		'{"context":{"synthesis":{"audio":{"metadataoptions":{' +
		'"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"' +
		'},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
	);
}

/** 拼装 ssml 文本帧 */
function buildSSMLMessage(requestId: string, ssml: string): string {
	return (
		`X-RequestId:${requestId}\r\n` +
		"Content-Type:application/ssml+xml\r\n" +
		`X-Timestamp:${dateToString()}Z\r\n` +
		"Path:ssml\r\n\r\n" +
		`${ssml}`
	);
}

/**
 * 解析文本帧，返回 Path 值（如 turn.end / audio.metadata / turn.start / response）。
 * text 帧格式：多行 header（`Key:Value\r\n`）+ 空行 + body。
 */
function parseTextFramePath(data: string): string | null {
	const headerEnd = data.indexOf("\r\n\r\n");
	const headerSection = headerEnd >= 0 ? data.slice(0, headerEnd) : data;
	const match = headerSection.match(/Path:(\S+)/);
	return match ? match[1] : null;
}

/**
 * 解析 binary 帧：前 2 字节是 header 长度（big-endian），其后是 header（`\r\n` 分隔的 Key:Value），
 * 再后是 mp3 数据。返回 { path, audio }；非 audio 帧返回 path 且 audio 为空。
 */
function parseBinaryFrame(data: ArrayBuffer): { path: string | null; audio: Uint8Array | null } {
	const view = new DataView(data);
	if (data.byteLength < 2) {
		return { path: null, audio: null };
	}
	const headerLen = view.getUint16(0);
	if (headerLen + 2 > data.byteLength) {
		return { path: null, audio: null };
	}
	// header 内容在 [2, 2+headerLen)，audio 在 [headerLen+2, 末尾)
	const headerBytes = new Uint8Array(data, 2, headerLen);
	const headerStr = new TextDecoder().decode(headerBytes);
	const pathMatch = headerStr.match(/Path:(\S+)/);
	const path = pathMatch ? pathMatch[1] : null;
	const audioStart = headerLen + 2;
	const audio = audioStart < data.byteLength
		? new Uint8Array(data, audioStart)
		: null;
	return { path, audio };
}

/**
 * 用 Web Crypto API 计算 SHA256 的 hex 值。
 * 同步接口 generateSecMsGec 需要同步得到结果，而 SubtleCrypto.digest 是异步的；
 * 这里用同步的纯 JS SHA256 实现（适用于 DRM token 生成）。
 */
function sha256Hex(ascii: string): string {
	// 纯 JS SHA256 实现（基于 FIPS 180-4），避免依赖 SubtleCrypto 的异步性
	const K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const H = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f,
		0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	];

	const bytes = new TextEncoder().encode(ascii);
	const len = bytes.length;
	const bitLen = len * 8;
	// 填充：0x80 + 0...0 + 8 字节大端长度，总长对齐 64
	const paddedLen = Math.ceil((len + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes);
	padded[len] = 0x80;
	// 末尾 8 字节存 bit 长度（big-endian），支持到 2^32 位
	const dv = new DataView(padded.buffer);
	dv.setUint32(paddedLen - 4, bitLen >>> 0, false);

	const W = new Uint32Array(64);
	for (let i = 0; i < paddedLen; i += 64) {
		for (let j = 0; j < 16; j++) {
			W[j] = dv.getUint32(i + j * 4, false);
		}
		for (let j = 16; j < 64; j++) {
			const s0 = rotr(W[j - 15], 7) ^ rotr(W[j - 15], 18) ^ (W[j - 15] >>> 3);
			const s1 = rotr(W[j - 2], 17) ^ rotr(W[j - 2], 19) ^ (W[j - 2] >>> 10);
			W[j] = (W[j - 16] + s0 + W[j - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let j = 0; j < 64; j++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[j] + W[j]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		H[0] = (H[0] + a) >>> 0;
		H[1] = (H[1] + b) >>> 0;
		H[2] = (H[2] + c) >>> 0;
		H[3] = (H[3] + d) >>> 0;
		H[4] = (H[4] + e) >>> 0;
		H[5] = (H[5] + f) >>> 0;
		H[6] = (H[6] + g) >>> 0;
		H[7] = (H[7] + h) >>> 0;
	}

	return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** 32 位循环右移 */
function rotr(x: number, n: number): number {
	return (x >>> n) | (x << (32 - n));
}

/**
 * 合成语音：建 WebSocket 连接，发 config + ssml，收音频帧拼装成完整 mp3 的 ArrayBuffer。
 *
 * @param text 待合成文本
 * @param voice 语音短名
 * @param rate rate 百分比字符串（来自 formatEdgeRate）
 * @param timeoutMs 超时毫秒，默认 30000
 * @returns mp3 音频的 ArrayBuffer
 * @throws 连接失败 / 超时 / 未收到音频 / turn.end 前连接关闭
 */
export function synthesizeEdge(
	text: string,
	voice: string,
	rate: string,
	timeoutMs = 30000,
): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const connectId = generateConnectId();
		const secMsGec = generateSecMsGec();
		const url =
			`${WSS_URL}&ConnectionId=${connectId}` +
			`&Sec-MS-GEC=${secMsGec}` +
			`&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

		const chunks: Uint8Array[] = [];
		let audioReceived = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		const cleanup = (): void => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
		const fail = (err: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			try {
				ws.close();
			} catch {
				// noop
			}
			reject(err);
		};
		const done = (buf: ArrayBuffer): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			try {
				ws.close();
			} catch {
				// noop
			}
			resolve(buf);
		};

		let ws: WebSocket;
		try {
			ws = new WebSocket(url, undefined as never);
		} catch (e) {
			reject(new Error(`edge-tts 建连失败: ${e instanceof Error ? e.message : String(e)}`));
			return;
		}

		// 浏览器 WebSocket 不支持自定义请求头；Origin/User-Agent 由浏览器决定。
		// edge-tts 服务对此宽容（Origin/Token 校验非强制）。若服务端拒绝需另议。
		void WSS_HEADERS;

		timer = setTimeout(() => {
			fail(new Error(`edge-tts 合成超时（${timeoutMs}ms）`));
		}, timeoutMs);

		ws.binaryType = "arraybuffer";

		ws.onopen = (): void => {
			try {
				ws.send(buildConfigMessage());
				const ssml = buildSSML(text, voice, rate);
				ws.send(buildSSMLMessage(connectId, ssml));
			} catch (e) {
				fail(new Error(`edge-tts 发送消息失败: ${e instanceof Error ? e.message : String(e)}`));
			}
		};

		ws.onmessage = (ev: MessageEvent): void => {
			if (typeof ev.data === "string") {
				const path = parseTextFramePath(ev.data);
				if (path === "turn.end") {
					if (!audioReceived) {
						fail(new Error("edge-tts turn.end 但未收到音频数据"));
						return;
					}
					// 拼装所有音频帧
					const total = chunks.reduce((s, c) => s + c.length, 0);
					const merged = new Uint8Array(total);
					let offset = 0;
					for (const c of chunks) {
						merged.set(c, offset);
						offset += c.length;
					}
					done(merged.buffer);
				}
				// turn.start / response / audio.metadata 等忽略
				return;
			}
			if (ev.data instanceof ArrayBuffer) {
				const { path, audio } = parseBinaryFrame(ev.data);
				if (path === "audio" && audio && audio.length > 0) {
					audioReceived = true;
					// 复制一份（ev.data 的 buffer 可能被复用）
					chunks.push(new Uint8Array(audio));
				}
				// 非 audio 的 binary 帧（如 Path:audio 且无数据）忽略
			}
		};

		ws.onerror = (): void => {
			fail(new Error("edge-tts WebSocket 错误"));
		};

		ws.onclose = (ev: CloseEvent): void => {
			if (!settled) {
				if (!audioReceived) {
					fail(new Error(`edge-tts 连接关闭但未收到音频（code=${ev.code}）`));
				} else {
					// 连接关闭但已收到音频，按完成处理
					const total = chunks.reduce((s, c) => s + c.length, 0);
					const merged = new Uint8Array(total);
					let offset = 0;
					for (const c of chunks) {
						merged.set(c, offset);
						offset += c.length;
					}
					done(merged.buffer);
				}
			}
		};
	});
}
