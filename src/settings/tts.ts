import { Setting, SliderComponent } from "obsidian";
import type { SettingsContext } from "./context";
import { logError, errMsg } from "../log";
import {
	isWindowsTTSAvailable,
	listWindowsVoices,
	probeWindowsTTSOnce,
	setTTSConfig,
	type TtsEngine,
} from "../tts";

/** 「朗读」分组：引擎选择（google/windows）+ 各引擎语音行（按 engine 显隐）+ 语速。 */
export function renderTTSSection(ctx: SettingsContext, body: HTMLElement): void {
	const { plugin } = ctx;

	// 引擎切换时按 engine 显隐下方引擎相关行：用局部变量捕获引用（一次 render 内有效）
	let googleDomainSetting: Setting | null = null;
	let windowsVoiceSetting: Setting | null = null;

	// 朗读引擎：切换时按 engine 显隐下方引擎相关行
	new Setting(body)
		.setName("朗读引擎")
		.setDesc("选择 TTS 朗读引擎。Google 简单稳定；Windows 调用系统自带朗读，离线可用（仅 Windows 桌面端）。")
		.addDropdown(async (dropdown) => {
			dropdown
				.addOption("google", "Google Translate");
			// Windows 系统朗读仅在 Windows 桌面端可选，且内嵌 onecore_tts.exe 需真实可用：
			// 若 exe 在目标机器执行失败（如系统版本太低、.NET Framework 缺失），探测返回 false，
			// 则不显示该选项，由用户回退到 google。
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
					// 切换引擎时，把对应引擎的语音下发给 TTS 配置（google 无语音）
					setTTSConfig({
						engine,
						voice: engine === "windows"
							? plugin.settings.ttsWindowsVoice
							: "",
						rate: plugin.settings.ttsRate,
						googleDomain: plugin.settings.ttsGoogleDomain,
					});
					// 按 engine 切换引擎相关行的显隐，不重渲染整个页面
					googleDomainSetting?.settingEl.toggle(engine === "google");
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
						voice: "",
						rate: plugin.settings.ttsRate,
						googleDomain: v,
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
						voice: plugin.settings.ttsEngine === "windows"
							? plugin.settings.ttsWindowsVoice
							: "",
						rate: n,
						googleDomain: plugin.settings.ttsGoogleDomain,
					});
				});
		});
}
