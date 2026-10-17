import type { App } from "obsidian";

/** 折叠状态在 localStorage 的 key（多 vault 隔离的 UI 偏好，不进 data.json 业务配置） */
const SECTION_STATE_KEY = "nihong-ai-settings-section-state";

/** 读取所有分区的展开状态：title → 是否展开（缺失表示用默认值） */
function readSectionState(app: App): Record<string, boolean> {
	try {
		return (app.loadLocalStorage(SECTION_STATE_KEY) as Record<string, boolean>) ?? {};
	} catch (e) {
		console.warn("[nihong-ai] 读取分区折叠状态失败:", e);
		return {};
	}
}

/** 写入单个分区的展开状态（与现有状态合并后整体写回） */
function writeSectionState(app: App, title: string, open: boolean): void {
	const state = readSectionState(app);
	state[title] = open;
	try {
		app.saveLocalStorage(SECTION_STATE_KEY, state);
	} catch (e) {
		console.warn("[nihong-ai] 写入分区折叠状态失败:", e);
	}
}

/**
 * 创建可折叠的设置分区（参考 lexis 的 createSettingsSection）。
 *
 * 用原生 <details>/<summary> 实现折叠（无需 Obsidian SettingGroup）：
 * 标题（summary）点击切换展开/收起。分区带边框圆角、标题前有箭头标识（展开时旋转 90°）。
 * 返回 body 元素，调用方往 body 里 new Setting(body).setName(...).addX(...) 添加设置项。
 *
 * 折叠状态持久化：传 app 时，初始展开状态从 localStorage 读取（缺失用 open 默认值），
 * 点击切换时回写，下次进入设置页保持上次的折叠状态（多 vault 隔离的 UI 偏好，不进 data.json）。
 *
 * @param container 父容器（设置页主体）
 * @param title 分区标题（同时作折叠状态的 key）
 * @param app Obsidian App（用于读写折叠状态）；不传则不持久化（默认全展开）
 * @param open 未有历史状态时的默认展开值（默认 true）
 * @param desc 标题旁的描述（可选）
 * @returns body 元素（往里加设置项）
 */
export function createSettingsSection(
	container: HTMLElement,
	title: string,
	{ app, open = true, desc = "" }: { app?: App; open?: boolean; desc?: string } = {},
): HTMLElement {
	const element = container.createEl("details", { cls: "nihong-ai-settings-section" });
	const heading = element.createEl("summary", { cls: "nihong-ai-settings-section-heading" });
	const label = heading.createDiv({ cls: "nihong-ai-settings-section-label" });
	label.createSpan({ cls: "nihong-ai-settings-section-title", text: title });
	if (desc) {
		label.createSpan({ cls: "nihong-ai-settings-section-hint", text: desc });
	}
	const body = element.createDiv({ cls: "nihong-ai-settings-section-body" });
	const details = element as HTMLDetailsElement;
	// 初始展开状态：有历史记录用历史，否则用 open 默认值
	const saved = app ? readSectionState(app)[title] : undefined;
	details.open = saved !== undefined ? saved : open;
	// 切换时回写，保持下次进入时的状态
	if (app) {
		details.addEventListener("toggle", () => {
			writeSectionState(app, title, details.open);
		});
	}
	return body;
}
