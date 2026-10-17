/**
 * 创建可折叠的设置分区（参考 lexis 的 createSettingsSection）。
 *
 * 用原生 <details>/<summary> 实现折叠（无需 Obsidian SettingGroup）：
 * 标题（summary）点击切换展开/收起，默认展开。分区带边框圆角、标题前有箭头标识（展开时旋转 90°）。
 * 返回 body 元素，调用方往 body 里 new Setting(body).setName(...).addX(...) 添加设置项。
 *
 * @param container 父容器（设置页主体）
 * @param title 分区标题
 * @param open 是否默认展开（默认 true）
 * @param desc 标题旁的描述（可选）
 * @returns body 元素（往里加设置项）
 */
export function createSettingsSection(
	container: HTMLElement,
	title: string,
	{ open = true, desc = "" }: { open?: boolean; desc?: string } = {},
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
	details.open = open;
	return body;
}
