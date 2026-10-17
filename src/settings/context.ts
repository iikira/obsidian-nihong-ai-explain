import type { App } from "obsidian";
import type NihongAIExplainPlugin from "../main";

/**
 * 各分组渲染函数的共享上下文。
 *
 * 每个分组渲染函数签名为 `(ctx: SettingsContext, body: HTMLElement): void`：
 * `body` 是该分组可折叠分区（createSettingsSection 返回）的 body，
 * `ctx` 提供插件（settings / 服务对象）、Obsidian App、以及整树重渲染回调。
 */
export interface SettingsContext {
	plugin: NihongAIExplainPlugin;
	app: App;
	/** 重渲染整个设置树（等价于旧 SettingTab 的 this.update()） */
	update: () => void;
}
