/**
 * Windows 系统朗读引擎：通过 PowerShell 调用系统自带 SAPI5 SpVoice 合成语音。
 *
 * 仅 Windows 桌面端可用：Obsidian 桌面端基于 Electron，可通过 window.require
 * 访问 Node 的 child_process 启动 powershell.exe。移动端（iOS/Android）无
 * child_process / PowerShell，不可用。
 *
 * 与 edge-tts（微软在线云服务）不同：本引擎调用操作系统本地 SAPI5，完全离线，
 * 不依赖网络。音质为传统拼接合成，不如 Edge Neural，定位为离线备用。
 *
 * 编码要点：日语文本经 Node → PowerShell 传参必然乱码，故把整段 PowerShell
 * 脚本（含日语文本）以 UTF-16LE base64 编码后用 -EncodedCommand 传递。
 */

// 仅桌面端 Electron 环境有 window.require，用动态 require 拿 child_process
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = globalThis as any;

/** 拿到 child_process.execFile（仅桌面端可用；移动端返回 null） */
function getExecFile(): ((file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string, stderr: string) => void) => void) | null {
	try {
		const cp = g.require?.("child_process");
		return typeof cp?.execFile === "function" ? cp.execFile : null;
	} catch {
		return null;
	}
}

/**
 * 检测 Windows 系统朗读是否可用：桌面端 + Windows 平台 + child_process 可访问。
 * 移动端 / macOS / Linux 返回 false。
 */
export function isWindowsTTSAvailable(): boolean {
	try {
		const platform = g.process?.platform;
		const execFile = getExecFile();
		return platform === "win32" && execFile !== null;
	} catch {
		return false;
	}
}

/**
 * 把统一语速倍率（0.5–3.0，1.0=正常）映射到 SAPI Rate（-10~10，0=正常）。
 * 1.0 → 0，2.0 → 5，3.0 → 10，0.5 → -5。clamp 到 [-10, 10]。
 */
export function formatWindowsRate(ttsRate: number): number {
	const r = Math.round((ttsRate - 1) * 5);
	if (r < -10) {
		return -10;
	}
	if (r > 10) {
		return 10;
	}
	return r;
}

/** Windows 语音条目（GetVoices() 返回的描述） */
export interface WindowsVoice {
	/** SAPI voice 的完整描述（GetDescription()），用作合成时的匹配标识 */
	id: string;
	/** 显示名称（去掉冗余前缀后的友好名） */
	name: string;
}

/** 语音列表会话内缓存（避免每次设置页打开都起 PowerShell） */
let windowsVoicesCache: WindowsVoice[] | null = null;

/**
 * 枚举系统已安装的日语语音（SAPI5 SpVoice.GetVoices() 中描述含 "Japanese" 的）。
 * 仅 Windows 桌面端可用；非 Windows / 不可用返回空数组。会话内缓存。
 */
export async function listWindowsVoices(): Promise<WindowsVoice[]> {
	if (windowsVoicesCache) {
		return windowsVoicesCache;
	}
	const execFile = getExecFile();
	console.log("[nihong-ai-explain tts] listWindowsVoices: platform=", g.process?.platform, "execFile=", !!execFile);
	if (!execFile || g.process?.platform !== "win32") {
		windowsVoicesCache = [];
		return windowsVoicesCache;
	}
	// 用单引号包裹的换行符作为 join 分隔，避免脚本里嵌入反引号转义
	const sep = String.fromCharCode(10); // \n
	const psScript = [
		`$ErrorActionPreference = 'Stop'`,
		`$sp = New-Object -ComObject SAPI.SpVoice`,
		`$out = @()`,
		`foreach ($v in $sp.GetVoices()) {`,
		`  $d = $v.GetDescription()`,
		`  if ($d -like '*Japanese*') { $out += $d }`,
		`}`,
		`[string]::Join('${sep}', $out)`,
	].join("\r\n");
	const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");
	const rawLines: string[] = await new Promise<string[]>((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
			{ timeout: 15000, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					console.warn("[nihong-ai-explain tts] 枚举 Windows 语音失败:", err.message);
					resolve([]);
					return;
				}
				const text = (stdout || "").replace(/<#[^]*#>/g, "").trim();
				const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
				console.log("[nihong-ai-explain tts] 枚举到 Windows 语音原始行:", lines, "stderr:", (stderr || "").slice(0, 120));
				resolve(lines);
			},
		);
	});
	const voices: WindowsVoice[] = rawLines.map((line) => ({
		id: line,
		// 友好名：去掉 "Microsoft " 前缀与 " - Japanese" 后缀
		name: line.replace(/^Microsoft\s+/i, "").replace(/\s*-\s*Japanese.*$/i, ""),
	}));
	windowsVoicesCache = voices;
	return voices;
}

/**
 * 合成语音：PowerShell 调用 SAPI5 SpVoice，输出 WAV（PCM），返回 ArrayBuffer。
 *
 * @param text 待合成文本
 * @param rate 统一语速倍率（0.5–3.0，1.0=正常）
 * @param voice 语音描述（GetDescription() 的精确匹配；空则取第一个日语语音）
 * @returns WAV 音频的 ArrayBuffer
 * @throws 非 Windows 平台 / child_process 不可用 / 合成失败 / 未返回数据
 */
export async function synthesizeWindows(
	text: string,
	rate: number,
	voice: string,
): Promise<ArrayBuffer> {
	const execFile = getExecFile();
	if (!execFile || g.process?.platform !== "win32") {
		throw new Error("Windows 系统朗读仅在 Windows 桌面端可用");
	}

	const sapiRate = formatWindowsRate(rate);
	// 日语文本 → UTF-16LE base64，脚本内解码，避免编码乱码
	const textBase64 = Buffer.from(text, "utf16le").toString("base64");
	// 语音匹配：优先精确匹配描述，其次匹配 *Japanese*，找不到则用默认
	const voiceMatchBase64 = Buffer.from(voice || "", "utf16le").toString("base64");
	const psScript = [
		`$ErrorActionPreference = 'Stop'`,
		`$text = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${textBase64}'))`,
		`$voiceDesc = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${voiceMatchBase64}'))`,
		`$sp = New-Object -ComObject SAPI.SpVoice`,
		`$ja = $null`,
		`foreach ($v in $sp.GetVoices()) {`,
		`  $d = $v.GetDescription()`,
		`  if ($voiceDesc -and $d -eq $voiceDesc) { $ja = $v; break }`,
		`}`,
		`if (-not $ja) { foreach ($v in $sp.GetVoices()) { if ($v.GetDescription() -like '*Japanese*') { $ja = $v; break } } }`,
		`if ($ja) { $sp.Voice = $ja }`,
		`$sp.Rate = ${sapiRate}`,
		`$p = Join-Path $env:TEMP 'nihong_ai_tts.wav'`,
		`$s = New-Object -ComObject SAPI.SpFileStream`,
		`$s.Open($p, 3, 0)`,
		`$sp.AudioOutputStream = $s`,
		`$sp.Speak($text, 0) | Out-Null`,
		`$s.Close()`,
		`$b = [System.IO.File]::ReadAllBytes($p)`,
		`[Convert]::ToBase64String($b)`,
		`Remove-Item $p -Force`,
	].join("\r\n");

	// 整段脚本以 UTF-16LE base64 用 -EncodedCommand 传递，确保 Unicode 安全
	const encodedCommand = Buffer.from(psScript, "utf16le").toString("base64");

	return new Promise<ArrayBuffer>((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
			{ timeout: 30000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					reject(new Error(`Windows SAPI 朗读失败: ${err.message}`));
					return;
				}
				const base64 = (stdout || "").trim();
				// 过滤 PS 可能输出的非 base64 行，取最后一段长字符串
				const match = base64.match(/[A-Za-z0-9+/=]{100,}/);
				if (!match) {
					reject(new Error("Windows SAPI 朗读未返回音频数据（请确认系统已安装日语语音包）"));
					return;
				}
				resolve(Buffer.from(match[0], "base64").buffer);
			},
		);
	});
}
