import { requestUrl, Setting, SliderComponent } from "obsidian";
import type { SettingsContext } from "./context";
import { logWarn, logError, errMsg } from "../log";
import {
	isWindowsTTSAvailable,
	listWindowsVoices,
	probeWindowsTTSOnce,
	setTTSConfig,
	type TtsEngine,
} from "../tts";

/** edge 语音列表缓存（会话内只拉一次） */
let edgeVoicesCache: { shortName: string; friendlyName: string }[] | null = null;

/**
 * 拉取 edge-tts 日文语音列表（过滤 Locale 以 ja 开头）。
 * 拉取失败返回降级固定列表。会话内缓存，不重复请求。
 */
async function fetchEdgeVoices(): Promise<{ shortName: string; friendlyName: string }[]> {
	if (edgeVoicesCache) {
		return edgeVoicesCache;
	}
	const VOICE_LIST_URL =
		"https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
	try {
		const resp = await requestUrl({ url: VOICE_LIST_URL, method: "GET", throw: false });
		if (resp.status < 200 || resp.status >= 300) {
			logWarn("settings", `拉取 edge 语音列表失败: HTTP ${resp.status}`);
		} else {
			const list = resp.json as Array<{
				ShortName: string;
				FriendlyName: string;
				Locale: string;
			}>;
			const ja = list
				.filter((v) => v.Locale && v.Locale.toLowerCase().startsWith("ja"))
				.map((v) => ({ shortName: v.ShortName, friendlyName: v.FriendlyName }))
				.sort((a, b) => a.shortName.localeCompare(b.shortName));
			if (ja.length > 0) {
				edgeVoicesCache = ja;
				return ja;
			}
		}
	} catch (e) {
		logWarn("settings", `拉取 edge 语音列表出错: ${errMsg(e)}`);
	}
	// 降级固定列表
	edgeVoicesCache = [
		{ shortName: "ja-JP-NanamiNeural", friendlyName: "Microsoft Nanami Online (Natural) - Japanese (Japan)" },
		{ shortName: "ja-JP-KeitaNeural", friendlyName: "Microsoft Keita Online (Natural) - Japanese (Japan)" },
	];
	return edgeVoicesCache;
}

/** 「朗读」分组：引擎选择 + 三引擎各自语音行（按 engine 显隐）+ 语速。 */
export function renderTTSSection(ctx: SettingsContext, body: HTMLElement): void {
	const { plugin } = ctx;

	// 引擎切换时按 engine 显隐下方三个引擎相关行：用局部变量捕获引用（一次 render 内有效）
	let googleDomainSetting: Setting | null = null;
	let edgeVoiceSetting: Setting | null = null;
	let windowsVoiceSetting: Setting | null = null;

	// 朗读引擎：切换时按 engine 显隐下方三个引擎相关行
	new Setting(body)
		.setName("朗读引擎")
		.setDesc("选择 TTS 朗读引擎。Google 简单稳定；Edge 暂不可用；Windows 调用系统自带朗读，离线可用（仅 Windows 桌面端）。")
		.addDropdown(async (dropdown) => {
			dropdown
				.addOption("google", "Google Translate")
				.addOption("edge", "Edge TTS");
			// Windows 系统朗读仅在 Windows 桌面端可选，且内嵌 onecore_tts.exe 需真实可用：
			// 若 exe 在目标机器执行失败（如系统版本太低、.NET Framework 缺失），探测返回 false，
			// 则不显示该选项，由用户回退到其它引擎。
			const winAvail = await probeWindowsTTSOnce();
			if (winAvail) {
				dropdown.addOption("windows", "Windows 系统朗读");
			}
			// 若当前值不可用（如移动端选中过 windows，或 exe 执行失败），回退到 google
			let value = plugin.settings.ttsEngine;
			if (value === "windows" && !winAvail) {
				value = "google";
				plugin.settings.ttsEngine = "google";
				await plugin.saveSettings();
			}
			dropdown.setValue(value)
				.onChange(async (engineVal) => {
					const engine = engineVal as TtsEngine;
					plugin.settings.ttsEngine = engine;
					await plugin.saveSettings();
					// 切换引擎时，把对应引擎的语音下发给 TTS 配置
					setTTSConfig({
						engine,
						voice: engine === "windows"
							? plugin.settings.ttsWindowsVoice
							: plugin.settings.ttsEdgeVoice,
						rate: plugin.settings.ttsRate,
						googleDomain: plugin.settings.ttsGoogleDomain,
					});
					// 按 engine 切换三个引擎相关行的显隐，不重渲染整个页面
					googleDomainSetting?.settingEl.toggle(engine === "google");
					edgeVoiceSetting?.settingEl.toggle(engine === "edge");
					windowsVoiceSetting?.settingEl.toggle(engine === "windows");
				});
		});

	// Google Translate 域名（仅 google 引擎显示）
	{
		const s = new Setting(body)
			.setName("Google Translate 域名")
			.setDesc("Google Translate 的自定义域名");
		googleDomainSetting = s;
		s.settingEl.toggle(plugin.settings.ttsEngine === "google");
		s.addText((text) => {
			text.setPlaceholder("translate.google.com")
				.setValue(plugin.settings.ttsGoogleDomain)
				.onChange(async (value) => {
					const v = value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
					plugin.settings.ttsGoogleDomain = v;
					await plugin.saveSettings();
					setTTSConfig({
						engine: plugin.settings.ttsEngine,
						voice: plugin.settings.ttsEdgeVoice,
						rate: plugin.settings.ttsRate,
						googleDomain: v,
					});
				});
		});
	}

	// Edge 语音（仅 edge 引擎显示）
	{
		const s = new Setting(body)
			.setName("Edge 语音")
			.setDesc("选择 Edge TTS 的日文语音。");
		edgeVoiceSetting = s;
		s.settingEl.toggle(plugin.settings.ttsEngine === "edge");
		s.addDropdown(async (dropdown) => {
			dropdown.addOption(
				plugin.settings.ttsEdgeVoice || "ja-JP-NanamiNeural",
				"加载中…",
			);
			dropdown.setValue(
				plugin.settings.ttsEdgeVoice || "ja-JP-NanamiNeural",
			);
			const voices = await fetchEdgeVoices();
			dropdown.selectEl.empty();
			for (const v of voices) {
				dropdown.addOption(v.shortName, v.friendlyName);
			}
			const current = plugin.settings.ttsEdgeVoice;
			if (!voices.some((v) => v.shortName === current)) {
				const fallback = voices[0]?.shortName ?? "ja-JP-NanamiNeural";
				plugin.settings.ttsEdgeVoice = fallback;
				await plugin.saveSettings();
			}
			dropdown.setValue(plugin.settings.ttsEdgeVoice);
			dropdown.onChange(async (value) => {
				plugin.settings.ttsEdgeVoice = value;
				await plugin.saveSettings();
				setTTSConfig({
					engine: plugin.settings.ttsEngine,
					voice: value,
					rate: plugin.settings.ttsRate,
					googleDomain: plugin.settings.ttsGoogleDomain,
				});
			});
		});
	}

	// Windows 语音（仅 Windows 桌面端且 windows 引擎显示）
	if (isWindowsTTSAvailable()) {
		const s = new Setting(body)
			.setName("Windows 语音")
			.setDesc("选择 Windows 系统朗读的日文语音（来自系统已安装的语音包）。");
		windowsVoiceSetting = s;
		s.settingEl.toggle(plugin.settings.ttsEngine === "windows");
		s.addDropdown(async (dropdown) => {
			dropdown.addOption("", "加载中…");
			dropdown.setValue("");
			let voices;
			try {
				voices = await listWindowsVoices();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				logError("settings", `listWindowsVoices 抛错: ${errMsg(e)}`);
				dropdown.selectEl.empty();
				dropdown.addOption("", `加载失败：${msg}`);
				dropdown.setValue("");
				return;
			}
			dropdown.selectEl.empty();
			if (voices.length === 0) {
				dropdown.addOption("", "未检测到日语语音（请在系统安装日语语音包）");
				dropdown.setValue("");
				return;
			}
			for (const v of voices) {
				dropdown.addOption(v.id, v.name);
			}
			const current = plugin.settings.ttsWindowsVoice;
			if (!current || !voices.some((v) => v.id === current)) {
				const fallback = voices[0].id;
				plugin.settings.ttsWindowsVoice = fallback;
				await plugin.saveSettings();
			}
			dropdown.setValue(plugin.settings.ttsWindowsVoice);
			dropdown.onChange(async (value) => {
				plugin.settings.ttsWindowsVoice = value;
				await plugin.saveSettings();
				setTTSConfig({
					engine: plugin.settings.ttsEngine,
					voice: value,
					rate: plugin.settings.ttsRate,
					googleDomain: plugin.settings.ttsGoogleDomain,
				});
			});
		});
	}

	// 朗读语速
	new Setting(body)
		.setName("朗读语速")
		.setDesc("TTS 朗读语速倍率，范围 0.5–3.0，1.0 为正常速度。修改后下次朗读生效。")
		.addSlider((slider: SliderComponent) => {
			slider
				.setLimits(0.5, 3.0, 0.1)
				.setValue(plugin.settings.ttsRate)
				.onChange(async (value) => {
					// 步长 0.1 浮点累差容错：四舍五入到一位小数
					const n = Math.round(value * 10) / 10;
					plugin.settings.ttsRate = n;
					await plugin.saveSettings();
					setTTSConfig({
						engine: plugin.settings.ttsEngine,
						voice: plugin.settings.ttsEdgeVoice,
						rate: n,
						googleDomain: plugin.settings.ttsGoogleDomain,
					});
				});
		});
}
