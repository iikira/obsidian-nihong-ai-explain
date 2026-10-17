import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type NihongAIExplainPlugin from "./main";
import { createSettingsSection } from "./settings/section";
import type { SettingsContext } from "./settings/context";
// 类型/默认值从 types.ts 搬出；re-export 保持外部 import 来源（main.ts / 三个 service）不变
export { ModelGroup, NihongAIExplainSettings, DEFAULT_SETTINGS } from "./settings/types";
import { renderOutputDirSection } from "./settings/outputDir";
import { renderModelGroupSection } from "./settings/modelGroup";
import { renderSamplingSection } from "./settings/sampling";
import { renderDictionarySection } from "./settings/dictionary";
import { renderTTSSection } from "./settings/tts";
import { renderCacheSection } from "./settings/cache";
import { renderOfflineDictSection } from "./settings/offlineDict";

export class NihongAIExplainSettingTab extends PluginSettingTab {
	plugin: NihongAIExplainPlugin;

	constructor(app: App, plugin: NihongAIExplainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * 声明式设置入口：返回一个根定义，其 render 命令式渲染整个设置树（参考 lexis）。
	 * 用 createSettingsSection 渲染可折叠分区（<details>/<summary>，默认展开，点击标题折叠/展开）。
	 * 各分组的渲染逻辑拆到 src/settings/ 下独立文件，各自导出一个 renderXxxSection(ctx, body)。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Nihong AI 讲解",
				aliases: ["朗读", "翻译", "词典", "大模型", "Jitendex", "TTS", "Lexis"],
				render: (setting: Setting) => {
					this.renderSettings(setting.settingEl);
				},
			},
		];
	}

	/** 渲染整个设置页：7 个可折叠分区。各分区内由对应 renderXxxSection 渲染设置项。 */
	private renderSettings(containerEl: HTMLElement): void {
		containerEl.empty();
		// setting.settingEl 是 .setting-item（flex 布局），直接往里渲染会让分区横向排列。
		// 改用一个块级子 div 作真正根容器，分区在此垂直堆叠。
		const root = containerEl.createDiv({ cls: "nihong-ai-settings-root" });
		const ctx: SettingsContext = {
			plugin: this.plugin,
			app: this.app,
			update: () => this.update(),
		};

		renderOutputDirSection(ctx, createSettingsSection(root, "输出目录"));
		renderModelGroupSection(ctx, createSettingsSection(root, "大模型分组"));
		renderSamplingSection(ctx, createSettingsSection(root, "采样参数"));
		renderDictionarySection(ctx, createSettingsSection(root, "词典与显示"));
		renderTTSSection(ctx, createSettingsSection(root, "朗读"));
		renderCacheSection(ctx, createSettingsSection(root, "缓存管理"));
		renderOfflineDictSection(ctx, createSettingsSection(root, "离线词典"));
	}
}
