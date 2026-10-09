import {
	App,
	ButtonComponent,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
	SliderComponent,
	requestUrl,
} from "obsidian";
import type NihongAIExplainPlugin from "./main";
import { FolderSuggest } from "./settings/folderSuggest";
import type { JitendexSourceInfo } from "./dictionary/manager";
import {
	clearTTSCache,
	getTTSCacheSize,
	setTTSConfig,
	type TtsEngine,
} from "./tts";

export interface ModelGroup {
	/** 分组唯一 id（uuid 或固定字符串） */
	id: string;
	/** 显示名称 */
	name: string;
	/** API 根地址 */
	apiUrl: string;
	/** 模型 id */
	modelId: string;
	/** API Key，可选 */
	apiKey: string;
}

export interface NihongAIExplainSettings {
	/** 笔记输出目录，相对 vault 根，空字符串=根目录 */
	outputDir: string;
	/** 语法拆解输出目录，相对 vault 根，空字符串=根目录 */
	grammarOutputDir: string;
	/** 大模型分组列表 */
	modelGroups: ModelGroup[];
	/** 当前在设置页编辑的分组 id */
	activeModelGroupId: string;
	/** AI 讲解用的大模型分组 id */
	explainModelGroupId: string;
	/** 语法拆解用的大模型分组 id */
	grammarModelGroupId: string;
	/** 翻译用的大模型分组 id */
	translateModelGroupId: string;
	/** 采样温度 */
	temperature: number;
	/** 最大重试次数 */
	maxRetries: number;
	/** 重试间隔（毫秒） */
	retryInterval: number;
	/** 单次请求超时（毫秒） */
	requestTimeout: number;
	/** 翻译目标语言 */
	targetLanguage: string;
	/** 词典卡片字号（px），0=使用默认 */
	dictFontSize: number;
	/** TTS 朗读语速（0.5–3.0，1.0=正常） */
	ttsRate: number;
	/** TTS 引擎：google / edge */
	ttsEngine: TtsEngine;
	/** edge 引擎语音短名（如 ja-JP-NanamiNeural） */
	ttsEdgeVoice: string;
	/** 禁用 Lexis 选区悬浮窗（开启后改用本插件自带 pill） */
	disableLexisPill: boolean;
}


export const DEFAULT_SETTINGS: NihongAIExplainSettings = {
	outputDir: "",
	grammarOutputDir: "",
	modelGroups: [
		{
			id: "default",
			name: "默认",
			apiUrl: "https://api.deepseek.com/v1",
			modelId: "deepseek-flash",
			apiKey: "",
		},
	],
	activeModelGroupId: "default",
	explainModelGroupId: "default",
	grammarModelGroupId: "default",
	translateModelGroupId: "default",
	temperature: 0.7,
	maxRetries: 3,
	retryInterval: 2000,
	requestTimeout: 120000,
	targetLanguage: "中文",
	dictFontSize: 0,
	ttsRate: 1.0,
	ttsEngine: "google",
	ttsEdgeVoice: "ja-JP-NanamiNeural",
	disableLexisPill: false,
};

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
			console.warn("[nihong-ai] 拉取 edge 语音列表失败: HTTP", resp.status);
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
		console.warn("[nihong-ai] 拉取 edge 语音列表出错:", e);
	}
	// 降级固定列表
	edgeVoicesCache = [
		{ shortName: "ja-JP-NanamiNeural", friendlyName: "Microsoft Nanami Online (Natural) - Japanese (Japan)" },
		{ shortName: "ja-JP-KeitaNeural", friendlyName: "Microsoft Keita Online (Natural) - Japanese (Japan)" },
	];
	return edgeVoicesCache;
}

export class NihongAIExplainSettingTab extends PluginSettingTab {
	plugin: NihongAIExplainPlugin;
	/** 当前分组下拉框引用，分组名变化时实时刷新选项 */
	private activeDropdown: DropdownComponent | null = null;
	/** 当前激活分组的编辑区容器（只显示一个分组），切换下拉框时重渲染 */
	private activeGroupContainer: HTMLDivElement | null = null;
	/** 当前激活分组「模型 id」下拉面板（列出 /v1/models 返回的模型，点击选择） */
	private activeModelListPanel: HTMLDivElement | null = null;
	/** 当前激活分组「模型 id」输入框引用（选择模型时回填用） */
	private activeModelInput: HTMLInputElement | null = null;

	constructor(app: App, plugin: NihongAIExplainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("单词解析输出目录")
			.setDesc("单词解析保存到此目录。留空则输出到根目录。")
			.addSearch((search) => {
				const apply = async (value: string): Promise<void> => {
					this.plugin.settings.outputDir = value.trim();
					await this.plugin.saveSettings();
				};
				search
					.setPlaceholder("单词解析")
					.setValue(this.plugin.settings.outputDir)
					.onChange((value) => void apply(value));
				// 输入时弹出 vault 文件夹候选下拉，可过滤与点选（交互参考 lexis）
				// 点选后 setValue 不会触发 onChange，需在 onPick 里直接保存
				new FolderSuggest(this.app, search.inputEl, (folder) => {
					search.setValue(folder);
					void apply(folder);
				});
			});

		new Setting(containerEl)
			.setName("语法拆解输出目录")
			.setDesc("语法拆解笔记保存到此目录。留空则输出到根目录。")
			.addSearch((search) => {
				const apply = async (value: string): Promise<void> => {
					this.plugin.settings.grammarOutputDir = value.trim();
					await this.plugin.saveSettings();
				};
				search
					.setPlaceholder("语法拆解")
					.setValue(this.plugin.settings.grammarOutputDir)
					.onChange((value) => void apply(value));
				new FolderSuggest(this.app, search.inputEl, (folder) => {
					search.setValue(folder);
					void apply(folder);
				});
			});

		// ====== 大模型分组管理 ======

		containerEl.createEl("h3", { text: "大模型分组" });

		new Setting(containerEl)
			.setName("当前分组")
			.setDesc("选择当前正在编辑的分组（下方编辑区显示该分组信息）。")
			.addDropdown((dropdown) => {
				this.activeDropdown = dropdown;
				this.refreshDropdownOptions();
				dropdown.setValue(this.plugin.settings.activeModelGroupId);
				// 下拉框选中即激活 + 重渲染下方编辑区
				dropdown.onChange(async (value) => {
					this.plugin.settings.activeModelGroupId = value;
					await this.plugin.saveSettings();
					this.rerenderActiveGroup();
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText("复制当前")
					.setTooltip("基于当前分组复制一个新分组")
					.onClick(async () => {
						const cur = this.plugin.settings.modelGroups.find(
							(g) => g.id === this.plugin.settings.activeModelGroupId,
						);
						if (!cur) {
							new Notice("未找到当前分组");
							return;
						}
						const id = `g_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
						const newName = this.uniqueGroupName(
							`${cur.name} (副本)`,
						);
						this.plugin.settings.modelGroups.push({
							id,
							name: newName,
							apiUrl: cur.apiUrl,
							modelId: cur.modelId,
							apiKey: cur.apiKey,
						});
						this.plugin.settings.activeModelGroupId = id;
						await this.plugin.saveSettings();
						this.display();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("新增分组")
					.setCta()
					.onClick(async () => {
						const id = `g_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
						this.plugin.settings.modelGroups.push({
							id,
							name: this.uniqueGroupName(
								`分组 ${this.plugin.settings.modelGroups.length + 1}`,
							),
							apiUrl: "https://api.deepseek.com/v1",
							modelId: "",
							apiKey: "",
						});
						this.plugin.settings.activeModelGroupId = id;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		// 分组编辑区容器（只显示当前激活的分组），由 rerenderActiveGroup 维护
		this.activeGroupContainer = containerEl.createDiv({
			cls: "nihong-ai-active-group",
		});
		this.renderActiveGroup();

		// AI 讲解大模型
		new Setting(containerEl)
			.setName("AI 讲解大模型")
			.setDesc("AI 讲解功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of this.plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(this.plugin.settings.explainModelGroupId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.explainModelGroupId = value;
					await this.plugin.saveSettings();
				});
			});

		// 翻译大模型
		new Setting(containerEl)
			.setName("翻译大模型")
			.setDesc("翻译功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of this.plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(this.plugin.settings.translateModelGroupId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.translateModelGroupId = value;
					await this.plugin.saveSettings();
				});
			});

		// 语法拆解大模型
		new Setting(containerEl)
			.setName("语法拆解大模型")
			.setDesc("语法拆解功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of this.plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(this.plugin.settings.grammarModelGroupId);
				dropdown.onChange(async (value) => {
					this.plugin.settings.grammarModelGroupId = value;
					await this.plugin.saveSettings();
				});
			});

		// ====== 提示词与采样 ======


		new Setting(containerEl)
			.setName("温度 (temperature)")
			.addText((text) =>
				text
					.setPlaceholder("0.7")
					.setValue(String(this.plugin.settings.temperature))
					.onChange(async (value) => {
						const n = Number(value);
						if (!isNaN(n)) {
							this.plugin.settings.temperature = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("最大重试次数")
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.maxRetries))
					.onChange(async (value) => {
						const n = Math.max(0, Math.floor(Number(value) || 0));
						this.plugin.settings.maxRetries = n;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("重试间隔 (毫秒)")
			.addText((text) =>
				text
					.setPlaceholder("2000")
					.setValue(String(this.plugin.settings.retryInterval))
					.onChange(async (value) => {
						const n = Math.max(0, Math.floor(Number(value) || 0));
						this.plugin.settings.retryInterval = n;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("单次请求超时 (毫秒)")
			.addText((text) =>
				text
					.setPlaceholder("120000")
					.setValue(String(this.plugin.settings.requestTimeout))
					.onChange(async (value) => {
						const n = Math.max(1000, Math.floor(Number(value) || 0));
						this.plugin.settings.requestTimeout = n;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("翻译目标语言")
			.setDesc("翻译功能的目标语言，如「中文」「英文」等。")
			.addText((text) =>
				text
					.setPlaceholder("中文")
					.setValue(this.plugin.settings.targetLanguage)
					.onChange(async (value) => {
						this.plugin.settings.targetLanguage = value.trim() || "中文";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("词典卡片字号")
			.setDesc(
				"词典卡片正文基础字号（px），范围为 8–32，默认 0（使用 Obsidian 主题默认值）。修改后新打开的卡片生效。",
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.dictFontSize))
					.onChange(async (value) => {
						const n = Number(value);
						if (
							Number.isFinite(n) &&
							(n === 0 || (n >= 8 && n <= 32))
						) {
							this.plugin.settings.dictFontSize = n;
							await this.plugin.saveSettings();
							text.inputEl.style.borderColor = "";
						} else {
							text.inputEl.style.borderColor =
								"var(--text-error)";
						}
					})
			);

		new Setting(containerEl)
			.setName("禁用 Lexis 悬浮窗")
			.setDesc(
				"开启后完全阻止 Lexis 选区悬浮窗弹出，改用本插件自带悬浮按钮。需重新选词生效。",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.disableLexisPill)
					.onChange(async (value) => {
						this.plugin.settings.disableLexisPill = value;
						await this.plugin.saveSettings();
						this.plugin.applyLexisPillDisabled();
					}),
			);

		const engineSetting = new Setting(containerEl)
			.setName("朗读引擎")
			.setDesc("选择 TTS 朗读引擎。Google 简单稳定；Edge 音质更好、语音更多。");

		// edge 语音选择（始终创建，按引擎显隐，避免切换时重渲染整个页面）
		const edgeVoiceSetting = new Setting(containerEl)
			.setName("Edge 语音")
			.setDesc("选择 Edge TTS 的日文语音。");
		// 初始显隐：仅 edge 时显示
		edgeVoiceSetting.settingEl.toggle(this.plugin.settings.ttsEngine === "edge");

		// 语音下拉异步填充（仅在显示时拉取）
		edgeVoiceSetting.addDropdown(async (dropdown) => {
			dropdown.addOption(
				this.plugin.settings.ttsEdgeVoice || "ja-JP-NanamiNeural",
				"加载中…",
			);
			dropdown.setValue(
				this.plugin.settings.ttsEdgeVoice || "ja-JP-NanamiNeural",
			);
			const voices = await fetchEdgeVoices();
			dropdown.selectEl.empty();
			for (const v of voices) {
				dropdown.addOption(v.shortName, v.friendlyName);
			}
			const current = this.plugin.settings.ttsEdgeVoice;
			if (!voices.some((v) => v.shortName === current)) {
				const fallback = voices[0]?.shortName ?? "ja-JP-NanamiNeural";
				this.plugin.settings.ttsEdgeVoice = fallback;
				await this.plugin.saveSettings();
			}
			dropdown.setValue(this.plugin.settings.ttsEdgeVoice);
			dropdown.onChange(async (value) => {
				this.plugin.settings.ttsEdgeVoice = value;
				await this.plugin.saveSettings();
				setTTSConfig({
					engine: this.plugin.settings.ttsEngine,
					voice: value,
					rate: this.plugin.settings.ttsRate,
				});
			});
		});

		engineSetting.addDropdown((dropdown) => {
			dropdown
				.addOption("google", "Google Translate")
				.addOption("edge", "Edge TTS")
				.setValue(this.plugin.settings.ttsEngine)
				.onChange(async (value) => {
					const engine = value as TtsEngine;
					this.plugin.settings.ttsEngine = engine;
					await this.plugin.saveSettings();
					setTTSConfig({
						engine,
						voice: this.plugin.settings.ttsEdgeVoice,
						rate: this.plugin.settings.ttsRate,
					});
					// 仅切换 Edge 语音行的显隐，不重渲染整个页面
					edgeVoiceSetting.settingEl.toggle(engine === "edge");
				});
		});

		new Setting(containerEl)
			.setName("朗读语速")
			.setDesc(
				"TTS 朗读语速倍率，范围 0.5–3.0，1.0 为正常速度。修改后下次朗读生效。",
			)
			.addSlider((slider: SliderComponent) => {
				// 在滑块右侧追加常驻数值 span
				const valueSpan = document.createElement("span");
				valueSpan.className = "nihong-ai-tts-rate-value";
				valueSpan.style.marginLeft = "8px";
				valueSpan.style.minWidth = "2.5em";
				valueSpan.style.textAlign = "right";
				valueSpan.setText(this.plugin.settings.ttsRate.toFixed(1));
				slider.sliderEl.parentElement?.insertBefore(
					valueSpan,
					slider.sliderEl.nextSibling,
				);

				slider
					.setLimits(0.5, 3.0, 0.1)
					.setValue(this.plugin.settings.ttsRate)
					.setDynamicTooltip()
					.onChange(async (value) => {
						// 步长 0.1 浮点累差容错：四舍五入到一位小数
						const n = Math.round(value * 10) / 10;
						valueSpan.setText(n.toFixed(1));
						this.plugin.settings.ttsRate = n;
						await this.plugin.saveSettings();
						setTTSConfig({
							engine: this.plugin.settings.ttsEngine,
							voice: this.plugin.settings.ttsEdgeVoice,
							rate: n,
						});
					});
			});

		new Setting(containerEl)
			.setName("TTS 缓存")
			.setDesc(
				`LRU 缓存 TTS 音频，容量 128 条。当前 ${getTTSCacheSize()} 条。`,
			)
			.addButton((btn) =>
				btn
					.setButtonText("清空缓存")
					.setWarning()
					.onClick(async () => {
						clearTTSCache();
						new Notice("TTS 缓存已清空");
						this.display();
					})
			);

	const cacheSetting = new Setting(containerEl)
		.setName("翻译缓存")
		.setDesc(`LRU 缓存翻译结果，容量 1024 条。当前 ${this.plugin.translateCache?.size() ?? 0} 条。`)
		.addButton((btn) =>
			btn
				.setButtonText("清空缓存")
				.setWarning()
				.onClick(async () => {
					this.plugin.translateCache?.clear();
					new Notice("已清空翻译缓存");
					cacheSetting.setDesc(`LRU 缓存翻译结果，容量 1024 条。当前 0 条。`);
				})
		);

	// ====== 词典管理 ======

		containerEl.createEl("h3", { text: "离线词典" });

		// Jitendex 词典：一个按钮承担安装/更新（首次使用=安装，已安装=更新）
		const jitendexSetting = new Setting(containerEl)
			.setName("Jitendex 词典")
			.setDesc("检测中…");
		// 按钮引用：在 addButton 回调里赋值，供 refreshDictStatus 切换文案
		let jitendexBtn: ButtonComponent | null = null;

		/** 刷新 Jitendex 行：desc 显示已导入/最新版本，按钮文案随是否已安装切换 */
		const refreshDictStatus = async (forceLatest = false): Promise<void> => {
			const mgr = this.plugin.dictionaryManager;
			if (!mgr || !mgr.isReady) {
				jitendexSetting.setDesc("词典未初始化");
				return;
			}
			let info: JitendexSourceInfo | null = null;
			try {
				info = await mgr.getSourceInfo();
			} catch (e) {
				jitendexSetting.setDesc("获取词典源信息失败");
				console.warn("[nihong-ai] 获取 Jitendex 源信息失败:", e);
				return;
			}
			jitendexSetting.setDesc(this.formatJitendexDesc(info, forceLatest));
			// 已导入 → 「更新词典」；未导入 → 「安装词典」
			jitendexBtn?.setButtonText(
				info.installedRevision ? "更新词典" : "安装词典",
			);
		};

		jitendexSetting.addButton((btn) => {
			jitendexBtn = btn;
			btn.setButtonText("安装词典")
				.setCta()
				.setTooltip("从 Jitendex 官方源下载并导入最新版")
				.onClick(async () => {
					const mgr = this.plugin.dictionaryManager;
					if (!mgr) {
						return;
					}
					const installing =
						btn.buttonEl.textContent?.includes("安装") ?? false;
					btn.setButtonText(installing ? "安装中…" : "更新中…").setDisabled(true);
					try {
						const res = await mgr.updateJitendex();
						if (res.updated) {
							new Notice(
								`已${installing ? "安装" : "更新"}到 ${res.revision ?? "(未知版本)"}`,
								5000,
							);
						} else {
							new Notice(`已是最新版本: ${res.revision ?? "(未知)"}`);
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`${installing ? "安装" : "更新"}失败: ${msg}`, 8000);
						console.error("[nihong-ai] Jitendex 更新失败:", e);
					} finally {
						btn.setDisabled(false);
						await refreshDictStatus();
					}
				});
		});
		void refreshDictStatus();

		new Setting(containerEl)
			.setName("清空词典")
			.setDesc("清空 IndexedDB 中的所有词典数据。")
			.addButton((btn) =>
				btn
					.setButtonText("清空")
					.setWarning()
					.onClick(async () => {
						const mgr = this.plugin.dictionaryManager;
						if (!mgr) {
							return;
						}
						await mgr.clear();
					new Notice("已清空词典");
					await refreshDictStatus();
				}),
		);
	}

	/** 格式化 Jitendex 源信息为设置行描述文本 */
	private formatJitendexDesc(
		info: JitendexSourceInfo | null,
		forceLatest: boolean,
	): string {
		if (!info) {
			return "获取词典源信息失败";
		}
		const parts: string[] = [];
		if (info.installedRevision) {
			parts.push(`已导入: ${info.installedRevision}`);
		} else {
			parts.push("未导入");
		}
		if (info.latestRevision) {
			if (info.hasUpdate) {
				parts.push(`最新: ${info.latestRevision}（可更新）`);
			} else {
				parts.push(`最新: ${info.latestRevision}（已是最新）`);
			}
		} else if (forceLatest) {
			parts.push("最新版本获取失败");
		} else {
			parts.push("点击右侧按钮安装/更新");
		}
		return parts.join("；");
	}

	/** 清空激活分组编辑容器并重新渲染当前激活分组 */
	private rerenderActiveGroup(): void {
		if (!this.activeGroupContainer) {
			return;
		}
		this.activeGroupContainer.empty();
		this.renderActiveGroup();
	}

	/**
	 * 拉取当前分组的模型列表（GET {apiUrl}/models，apiKey 非空时带 Authorization 头），
	 * 填充「模型 id」下拉面板的可选项。失败时在面板里提示，不影响手动输入。
	 */
	private async refreshModelList(g: ModelGroup): Promise<void> {
		const panel = this.activeModelListPanel;
		if (!panel) {
			return;
		}
		panel.empty();
		const base = (g.apiUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) {
			panel.setText("未配置 API 地址，无法拉取模型列表");
			return;
		}
		const url = `${base}/models`;
		const headers: Record<string, string> = {};
		if (g.apiKey) {
			headers["Authorization"] = `Bearer ${g.apiKey}`;
		}
		let ids: string[];
		try {
			const resp = await requestUrl({ url, method: "GET", headers, throw: false });
			if (resp.status < 200 || resp.status >= 300) {
				console.warn(`[nihong-ai] 拉取模型列表 HTTP ${resp.status}: ${url}`);
				panel.setText(`拉取失败（HTTP ${resp.status}），可手动输入模型 id`);
				return;
			}
			const data = (resp.json as { data?: { id?: string }[] }).data ?? [];
			ids = data.map((m) => m.id).filter((x): x is string => !!x);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[nihong-ai] 拉取模型列表失败: ${msg}`);
			panel.setText("拉取失败，可手动输入模型 id");
			return;
		}
		if (ids.length === 0) {
			panel.setText("端点未返回任何模型，可手动输入");
			return;
		}
		for (const id of ids) {
			const item = panel.createDiv({ text: id, cls: "nihong-ai-model-option" });
			item.addEventListener("click", () => {
				const input = this.activeModelInput;
				if (input) {
					input.value = id;
					input.dispatchEvent(new Event("input", { bubbles: true }));
				}
				this.hideModelListPanel();
			});
		}
	}

	/** 隐藏并清空当前分组的模型下拉面板 */
	private hideModelListPanel(): void {
		if (this.activeModelListPanel) {
			this.activeModelListPanel.style.display = "none";
		}
	}

	/** 显示当前分组模型下拉面板；尚未拉取时先拉取 */
	private showModelListPanel(g: ModelGroup): void {
		const panel = this.activeModelListPanel;
		if (!panel) {
			return;
		}
		// 面板隐藏时切换为显示；已显示则收起
		if (panel.style.display !== "block") {
			panel.style.display = "block";
			void this.refreshModelList(g);
		} else {
			panel.style.display = "none";
		}
	}

	/** 只渲染当前激活的分组（标题行 + 3 个字段行） */
	private renderActiveGroup(): void {
		const host = this.activeGroupContainer;
		if (!host) {
			return;
		}
		const g = this.plugin.settings.modelGroups.find(
			(x) => x.id === this.plugin.settings.activeModelGroupId,
		);
		if (!g) {
			host.createEl("div", {
				text: "未选择分组",
				cls: "nihong-ai-group-empty",
			});
			return;
		}

		// 标题行：名称 + 删除按钮
		const headerSetting = new Setting(host)
			.setClass("nihong-ai-group-header")
			.setName("分组名")
			.setDesc("大模型分组名")
			.addText((text) => {
				text.setPlaceholder("分组名称");
				text.inputEl.classList.add("nihong-ai-group-name-input");
				text.setValue(g.name);
				// onChange 实时只校验非空（避免空值持久化），不校验重名（避免输入到一半撞名被拒）
				text.onChange(async (value) => {
					const v = value.trim();
					if (!v) {
						return;
					}
					g.name = v;
					await this.plugin.saveSettings();
					this.refreshDropdownOptions();
				});
				// blur 校验空 + 重名，最终一致性更新
				text.inputEl.addEventListener("blur", async () => {
					const v = text.inputEl.value.trim();
					if (!v) {
						new Notice("分组名称不能为空");
						text.inputEl.value = g.name;
						return;
					}
					// 检查重名（排除自身）
					const dup = this.plugin.settings.modelGroups.find(
						(x) => x.id !== g.id && x.name === v,
					);
					if (dup) {
						new Notice(`分组名称「${v}」已存在`);
						text.inputEl.value = g.name;
						return;
					}
					g.name = v;
					await this.plugin.saveSettings();
					// 全页重渲染：标题行 + 当前分组下拉框 + AI讲解/翻译下拉框 都同步新名
					this.display();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon("trash")
					.setTooltip("删除分组")
					.onClick(async () => {
						if (this.plugin.settings.modelGroups.length <= 1) {
							new Notice("至少保留一个分组");
							return;
						}
						const s = this.plugin.settings;
						const fallback = s.modelGroups[0]?.id ?? "";
						const idx = s.modelGroups.indexOf(g);
						s.modelGroups.splice(idx, 1);
						if (s.activeModelGroupId === g.id) {
							s.activeModelGroupId = fallback;
						}
						if (s.explainModelGroupId === g.id) {
							s.explainModelGroupId = fallback;
						}
						if (s.grammarModelGroupId === g.id) {
							s.grammarModelGroupId = fallback;
						}
						if (s.translateModelGroupId === g.id) {
							s.translateModelGroupId = fallback;
						}
						await this.plugin.saveSettings();
						this.display();
					});
			});

		// API 地址
		new Setting(host)
			.setName("API 地址")
			.setDesc("大模型 OpenAI 兼容 API 地址, 后缀需带上 /v1")
			.setClass("nihong-ai-group-field")
			.addText((text) => {
				text.setPlaceholder("https://api.example.com/v1");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.apiUrl);
				text.onChange(async (value) => {
					g.apiUrl = value.trim();
					await this.plugin.saveSettings();
					// 地址变更后重新拉取模型列表
					void this.refreshModelList(g);
				});
			});

		// 模型 id
		new Setting(host)
			.setName("模型 id")
			.setDesc("可从下拉选择端点返回的模型，也可手动输入任意模型 id。")
			.setClass("nihong-ai-group-field nihong-ai-model-field")
			.addText((text) => {
				text.setPlaceholder("deepseek-flash");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.modelId);
				this.activeModelInput = text.inputEl;
				// 创建下拉面板（挂在所在 setting-item 内，绝对定位到输入框下方）
				const row = text.inputEl.closest(".setting-item");
				let panel = row?.querySelector<HTMLDivElement>(".nihong-ai-model-panel");
				if (row && !panel) {
					panel = row.createDiv({ cls: "nihong-ai-model-panel" });
					panel.style.display = "none";
					this.activeModelListPanel = panel;
				}
				text.onChange(async (value) => {
					g.modelId = value.trim();
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon("chevron-down")
					.setTooltip("选择模型")
					.onClick(() => this.showModelListPanel(g));
			});

		// API Key
		new Setting(host)
			.setName("API Key")
			.setDesc("若端点需要鉴权则填入，无需可留空。")
			.setClass("nihong-ai-group-field")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.apiKey);
				text.onChange(async (value) => {
					g.apiKey = value;
					await this.plugin.saveSettings();
					// Key 变更后重新拉取模型列表（鉴权头变化）
					void this.refreshModelList(g);
				});
			});
	}

	/** 在现有分组名基础上确保不重名：若撞名则加 (2)/(3)... 后缀 */
	private uniqueGroupName(base: string): string {
		const groups = this.plugin.settings.modelGroups;
		if (!groups.some((g) => g.name === base)) {
			return base;
		}
		let i = 2;
		while (groups.some((g) => g.name === `${base} (${i})`)) {
			i++;
		}
		return `${base} (${i})`;
	}

	/** 重建当前分组下拉框的选项（清空后重新 add），保留当前选中值 */
	private refreshDropdownOptions(): void {
		const dropdown = this.activeDropdown;
		if (!dropdown) {
			return;
		}
		const cur = dropdown.getValue();
		// 清空旧 options
		while (dropdown.selectEl.firstChild) {
			dropdown.selectEl.removeChild(dropdown.selectEl.firstChild);
		}
		for (const g of this.plugin.settings.modelGroups) {
			dropdown.addOption(g.id, g.name || g.modelId || g.id);
		}
		// 恢复选中（若仍存在）
		const exists = this.plugin.settings.modelGroups.some(
			(g) => g.id === cur,
		);
		dropdown.setValue(
			exists ? cur : (this.plugin.settings.modelGroups[0]?.id ?? ""),
		);
	}
}
