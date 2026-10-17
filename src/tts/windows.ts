/**
 * Windows 系统朗读引擎：运行时释放内嵌的 onecore_tts.exe（C#，.NET Framework 原生 WinRT），
 * 调用 Windows OneCore 自然语音（Ayumi / Haruka / Ichiro，ja-JP）合成 WAV。
 *
 * 背景：Obsidian 桌面端基于 Electron，可通过 window.require 访问 Node child_process
 * 启动子进程。OneCore 自然语音需走 WinRT SpeechSynthesizer；PowerShell 5.1 无法读取
 * WinRT 异步结果、pwsh 缺 WinRT 投影程序集，故改为预编译的 C# 工具。该工具只依赖
 * 系统自带的 .NET Framework 4.x + 系统 WinRT 元数据，无需额外运行时，零下载、离线可用。
 *
 * exe 以 base64 字符串内嵌进 bundle（构建时生成 onecoreTtsB64.ts，方式与声调数据一致），
 * 运行时解码写出到系统临时目录再执行，随插件自包含、无需随包分发二进制文件。
 *
 * 可用性：仅 Windows 桌面端（Electron + win32 + child_process 可访问）。移动端不可用。
 * 若 exe 释放/执行失败（例如系统版本太低、.NET Framework 缺失），探测标记为不可用，
 * 设置页据此不显示 Windows 语音选项，由上层回退到其它引擎。
 *
 * 编码要点：SSML 与日语文本经 Node → 子进程 argv 传递，Windows 下 Node 用 UTF-16 编码
 * 参数，C# Main(args) 可正确收到，无需像 PowerShell 那样用 base64。
 */

import { ONECORE_TTS_B64 } from "./onecore/onecoreTtsB64";

// 仅桌面端 Electron 环境有 window.require，用动态 require 拿 child_process / fs / os / path
// （esbuild platform:browser 不会打包这些 require，故必须走 window.require 属性访问绕过打包器）。

/** Electron 全局上可动态 require Node 模块的极小接口（避免用 any / globalThis） */
interface ElectronGlobal {
	require?: (mod: string) => NodeModuleLike;
	process?: { platform?: string; env?: Record<string, string | undefined> };
}

/** require 返回的 Node 模块极小形状：带若干属性/方法，访问前都做 typeof 运行时检查 */
interface NodeModuleLike {
	[key: string]: ((...args: never[]) => unknown) | unknown;
}

/** Electron 全局对象（window.require / window.process） */
const electron: ElectronGlobal = (window as unknown as ElectronGlobal);

/** require 拿到的 fs 模块极小接口（仅用到的方法） */
interface FsModule {
	writeFileSync(path: string, data: Uint8Array): void;
	readFile(
		path: string,
		cb: (err: Error | null, data: Buffer) => void,
	): void;
}

/** require 拿到的 os 模块极小接口 */
interface OsModule {
	tmpdir(): string;
}

/** require 拿到的 path 模块极小接口 */
interface PathModule {
	join(...paths: string[]): string;
}

/** require 拿到的 child_process 模块极小接口 */
interface ChildProcessModule {
	execFile: (
		file: string,
		args: string[],
		opts: Record<string, unknown>,
		cb: (err: Error | null, stdout: string, stderr: string) => void,
	) => void;
}

/** 拿到 fs 模块（桌面端可用时返回，否则 null） */
function getFs(): FsModule | null {
	const mod = electron.require?.("fs");
	return mod && typeof mod.writeFileSync === "function"
		? (mod as unknown as FsModule)
		: null;
}

/** 拿到 os 模块 */
function getOs(): OsModule | null {
	const mod = electron.require?.("os");
	return mod && typeof mod.tmpdir === "function"
		? (mod as unknown as OsModule)
		: null;
}

/** 拿到 path 模块 */
function getPath(): PathModule | null {
	const mod = electron.require?.("path");
	return mod && typeof mod.join === "function"
		? (mod as unknown as PathModule)
		: null;
}

/** 拿到 child_process.execFile（仅桌面端可用；移动端返回 null） */
function getExecFile(): ChildProcessModule["execFile"] | null {
	try {
		const mod = electron.require?.("child_process");
		return mod && typeof mod.execFile === "function"
			? (mod.execFile as ChildProcessModule["execFile"])
			: null;
	} catch {
		return null;
	}
}

/** 当前平台（win32 / darwin / linux…；非桌面端可能为 undefined） */
function getPlatform(): string | undefined {
	return electron.process?.platform;
}

/** 运行时释放后的 onecore_tts.exe 绝对路径（会话内缓存，避免重复写出） */
let ttsExePath: string | null = null;

/** exe 实际可运行性探测结果：null=未测，true=可用，false=不可用 */
let windowsProbe: boolean | null = null;

/**
 * 把内嵌的 onecore_tts.exe（base64）解码写出到系统临时目录，返回路径。
 * 成功则缓存路径；失败（内嵌数据为空 / fs/os/path 不可用 / 写盘出错）返回 null。
 */
function ensureTtsExe(): string | null {
	if (ttsExePath) {
		return ttsExePath;
	}
	if (!ONECORE_TTS_B64) {
		console.warn("[nihong-ai-explain tts] 内嵌的 onecore_tts.exe 数据为空，无法释放");
		return null;
	}
	const fs = getFs();
	const os = getOs();
	const path = getPath();
	if (!fs || !os || !path) {
		console.warn("[nihong-ai-explain tts] fs/os/path 不可用，无法释放 onecore_tts.exe");
		return null;
	}
	try {
		// base64 → 字节
		const binStr = atob(ONECORE_TTS_B64);
		const bytes = new Uint8Array(binStr.length);
		for (let i = 0; i < binStr.length; i++) {
			bytes[i] = binStr.charCodeAt(i);
		}
		const exe = path.join(os.tmpdir(), "nihong_ai_onecore_tts.exe");
		fs.writeFileSync(exe, bytes);
		ttsExePath = exe;
		return exe;
	} catch (e) {
		console.warn("[nihong-ai-explain tts] 释放 onecore_tts.exe 失败:", e);
		return null;
	}
}

/**
 * 检测 Windows OneCore 朗读是否可用：桌面端 + Windows 平台 + child_process 可访问 + 内嵌 exe 可释放。
 * 移动端 / macOS / Linux / 内嵌数据缺失返回 false。
 */
export function isWindowsTTSAvailable(): boolean {
	try {
		if (getPlatform() !== "win32" || !getExecFile()) {
			return false;
		}
		// 内嵌 exe 数据存在 + 具备释放条件（fs/os/path）
		if (!ONECORE_TTS_B64) {
			return false;
		}
		return !!getFs() && !!getOs() && !!getPath();
	} catch {
		return false;
	}
}

/**
 * 探测 onecore_tts.exe 在目标机器上是否真的能运行（执行 list 校验退出码与输出）。
 * 结果会话内缓存。用于设置页决定是否显示 Windows 语音选项：若 exe 因版本太低等原因
 * 执行失败，返回 false，从而不显示对应选项。返回 Promise<boolean>。
 */
export async function probeWindowsTTSOnce(): Promise<boolean> {
	if (windowsProbe !== null) {
		return windowsProbe;
	}
	const execFile = getExecFile();
	if (!execFile || getPlatform() !== "win32") {
		windowsProbe = false;
		return false;
	}
	const exe = ensureTtsExe();
	if (!exe) {
		windowsProbe = false;
		return false;
	}
	windowsProbe = await new Promise<boolean>((resolve) => {
		try {
			execFile(
				exe,
				["list"],
				{ timeout: 8000, windowsHide: true },
				(err, stdout) => {
					resolve(!err && /VOICE\|/.test(stdout || ""));
				},
			);
		} catch {
			// execFile 对无法启动的 exe 会同步抛 spawn 异常（如系统版本太低、文件损坏），视为不可用
			resolve(false);
		}
	});
	if (!windowsProbe) {
		console.warn("[nihong-ai-explain tts] onecore_tts.exe 执行失败，Windows 系统朗读不可用");
	}
	return windowsProbe;
}

/**
 * 把统一语速倍率（0.5–3.0，1.0=正常）映射为 SSML prosody rate 百分比（+X% / -X%）。
 * 1.0 → +0%，2.0 → +100%，0.5 → -50%。clamp 到 [-75%, +200%]。
 */
export function formatWindowsRate(ttsRate: number): string {
	let pct = Math.round((ttsRate - 1) * 100);
	if (pct < -75) {
		pct = -75;
	}
	if (pct > 200) {
		pct = 200;
	}
	return (pct >= 0 ? "+" : "") + pct + "%";
}

/** Windows 语音条目（OneCore DisplayName + 语言） */
export interface WindowsVoice {
	/** OneCore 语音的 DisplayName（如 "Microsoft Ayumi"），用作合成时的匹配标识 */
	id: string;
	/** 显示名称（去掉 "Microsoft " 前缀后的友好名） */
	name: string;
}

/** 语音列表会话内缓存（避免每次设置页打开都起子进程） */
let windowsVoicesCache: WindowsVoice[] | null = null;

/** 日语语音的语言标签前缀（OneCore DisplayName 的 Language 属性，如 "ja-JP"） */
const JAPANESE_LANG_PREFIX = "ja";

/** 是否仅枚举日语语音（插件面向日语学习，非日语 OneCore 语音无意义） */
let onlyJapanese = true;

/** 设置是否仅枚举日语语音 */
export function setWindowsVoicesJapaneseOnly(v: boolean): void {
	onlyJapanese = v;
}

/**
 * 枚举系统已安装的 OneCore 语音（默认过滤出日语的，如 Ayumi/Haruka/Ichiro）。
 * 仅 Windows 桌面端可用；exe 释放/执行失败返回空数组。会话内缓存。
 */
export async function listWindowsVoices(): Promise<WindowsVoice[]> {
	if (windowsVoicesCache) {
		return windowsVoicesCache;
	}
	if (!(await probeWindowsTTSOnce())) {
		windowsVoicesCache = [];
		return windowsVoicesCache;
	}
	const execFile = getExecFile();
	const exe = ttsExePath!;
	const rawLines: string[] = await new Promise<string[]>((resolve) => {
		execFile!(
			exe,
			["list"],
			{ timeout: 15000, windowsHide: true },
			(err, stdout) => {
				if (err) {
					console.warn("[nihong-ai-explain tts] 枚举 Windows 语音失败:", err.message);
					windowsProbe = false;
					resolve([]);
					return;
				}
				const lines = (stdout || "")
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter((s) => s.startsWith("VOICE|"));
				resolve(lines);
			},
		);
	});
	const voices: WindowsVoice[] = [];
	for (const line of rawLines) {
		const parts = line.split("|");
		const displayName = parts[1];
		const lang = parts[2] || "";
		if (!displayName) {
			continue;
		}
		if (onlyJapanese && !lang.toLowerCase().startsWith(JAPANESE_LANG_PREFIX)) {
			continue;
		}
		voices.push({
			id: displayName,
			name: displayName.replace(/^Microsoft\s+/i, ""),
		});
	}
	windowsVoicesCache = voices;
	return voices;
}

/** XML 转义，防止文本中的 < & > 破坏 SSML 结构 */
function xmlEscape(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * 合成语音：释放并调用 onecore_tts.exe 用 OneCore 自然语音输出 WAV（PCM），返回 ArrayBuffer。
 *
 * @param text 待合成文本
 * @param rate 统一语速倍率（0.5–3.0，1.0=正常）
 * @param voice 语音 DisplayName（如 "Microsoft Ayumi"；空则用 exe 默认 Ayumi）
 * @returns WAV 音频的 ArrayBuffer
 * @throws 非 Windows 平台 / child_process 不可用 / exe 释放或执行失败 / 合成失败 / 未返回数据
 */
export async function synthesizeWindows(
	text: string,
	rate: number,
	voice: string,
): Promise<ArrayBuffer> {
	const execFile = getExecFile();
	if (!execFile || getPlatform() !== "win32") {
		throw new Error("Windows 系统朗读仅在 Windows 桌面端可用");
	}
	const exe = ensureTtsExe();
	if (!exe) {
		throw new Error("onecore_tts.exe 释放失败，Windows 系统朗读不可用");
	}

	const rateStr = formatWindowsRate(rate);
	const escaped = xmlEscape(text);
	// SSML：<prosody rate> 控速，xml:lang 为日语
	const ssml = `<speak version="1.0" xml:lang="ja-JP"><prosody rate="${rateStr}">${escaped}</prosody></speak>`;

	// 输出到系统临时目录的固定文件
	const env = electron.process?.env ?? {};
	const outPath = `${env.TEMP ?? env.TMP ?? "."}/nihong_ai_onecore.wav`;

	return new Promise<ArrayBuffer>((resolve, reject) => {
		try {
			execFile(
				exe,
				["synth", ssml, outPath, voice || "Ayumi"],
				{ timeout: 30000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
				(err, stdout) => {
					if (err) {
						reject(new Error(`Windows OneCore 朗读失败: ${err.message}`));
						return;
					}
					// 成功输出 "WAV|<path>|<bytes>"；失败输出 "ERR|<type>|<message>"
					const wavMatch = (stdout || "").match(/^WAV\|(.+)\|(\d+)$/m);
					if (!wavMatch) {
						const errLine = (stdout || "").match(/^ERR\|([^|]*)\|(.*)$/m);
						reject(
							new Error(
								errLine
									? `Windows OneCore 朗读失败: ${errLine[2] || errLine[1]}`
									: "Windows OneCore 朗读未返回音频数据（请确认已安装日语语音包）",
							),
						);
						return;
					}
					const size = Number(wavMatch[2]);
					if (!size || size <= 0) {
						reject(new Error("Windows OneCore 朗读返回空音频"));
						return;
					}
					// 从 exe 输出路径读回字节（用 window.require 拿 fs，避免 esbuild 打包 node 模块）
					const fs = getFs();
					if (!fs) {
						reject(new Error("读取 OneCore 音频失败：fs 不可用"));
						return;
					}
					fs.readFile(wavMatch[1], (ferr: Error | null, data: Buffer) => {
						if (ferr) {
							reject(new Error(`读取 OneCore 音频失败: ${ferr.message}`));
							return;
						}
						// 转 ArrayBuffer（Buffer.buffer 可能是 SharedArrayBuffer，需显式收窄）
						const ab = data.buffer.slice(
							data.byteOffset,
							data.byteOffset + data.byteLength,
						) as ArrayBuffer;
						resolve(ab);
					});
				},
			);
		} catch {
			// exe 无法启动（如系统版本太低）时同步抛 spawn 异常，转为 reject
			reject(new Error("Windows OneCore 朗读失败：无法启动 onecore_tts.exe"));
		}
	});
}
