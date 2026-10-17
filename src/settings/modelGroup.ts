import {
	DropdownComponent,
	Notice,
	Setting,
	requestUrl,
} from "obsidian";
import type { SettingsContext } from "./context";
import type { ModelGroup } from "./types";

/**
 * 大模型分组编辑器（状态化）：封装原 SettingTab 的 5 个私有字段 + 5 个私有方法。
 *
 * 一轮 renderSettings 调用 new 一个实例，把状态（下拉框引用、编辑区容器、模型列表面板/输入框）
 * 封装在实例里。ctx.update() 会整树重渲染、重新 new 一个实例。
 */
class ModelGroupEditor {
	/** 当前分组下拉框引用，分组名变化时实时刷新选项 */
	private activeDropdown: DropdownComponent | null = null;
	/** 当前激活分组的编辑区容器（只显示一个分组），切换下拉框时重渲染 */
	private activeGroupContainer: HTMLElement | null = null;
	/** 当前激活分组「模型 id」下拉面板（列出 /v1/models 返回的模型，点击选择） */
	private activeModelListPanel: HTMLDivElement | null = null;
	/** 当前激活分组「模型 id」输入框引用（选择模型时回填用） */
	private activeModelInput: HTMLInputElement | null = null;

	constructor(private ctx: SettingsContext) {}

	/**
	 * 渲染整个「大模型分组」区块（当前分组下拉+复制/新增按钮、分组编辑区、三个模型分配下拉）。
	 */
	render(body: HTMLElement): void {
		const { plugin, update } = this.ctx;
		// 当前分组：下拉 + 复制当前 + 新增分组
		new Setting(body)
			.setName("当前分组")
			.setDesc("选择当前正在编辑的分组。")
			.addDropdown((dropdown) => {
				this.activeDropdown = dropdown;
				this.refreshDropdownOptions();
				dropdown.setValue(plugin.settings.activeModelGroupId);
				// 下拉框选中即激活 + 重渲染下方编辑区
				dropdown.onChange(async (value) => {
					plugin.settings.activeModelGroupId = value;
					await plugin.saveSettings();
					this.rerenderActiveGroup();
				});
			})
			.addButton((btn) =>
				btn
					.setButtonText("复制当前")
					.setTooltip("基于当前分组复制一个新分组")
					.onClick(async () => {
						const cur = plugin.settings.modelGroups.find(
							(g) => g.id === plugin.settings.activeModelGroupId,
						);
						if (!cur) {
							new Notice("未找到当前分组");
							return;
						}
						const id = `g_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
						const newName = this.uniqueGroupName(`${cur.name} (副本)`);
						plugin.settings.modelGroups.push({
							id,
							name: newName,
							apiUrl: cur.apiUrl,
							modelId: cur.modelId,
							apiKey: cur.apiKey,
						});
						plugin.settings.activeModelGroupId = id;
						await plugin.saveSettings();
						update();
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("新增分组")
					.setCta()
					.onClick(async () => {
						const id = `g_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
						plugin.settings.modelGroups.push({
							id,
							name: this.uniqueGroupName(
								`分组 ${plugin.settings.modelGroups.length + 1}`,
							),
							apiUrl: "https://api.deepseek.com/v1",
							modelId: "",
							apiKey: "",
						});
						plugin.settings.activeModelGroupId = id;
						await plugin.saveSettings();
						update();
					}),
			);

		// 分组编辑区容器（只显示当前激活的分组），由 rerenderActiveGroup 维护
		this.activeGroupContainer = body.createDiv({
			cls: "nihong-ai-active-group",
		});
		this.renderActiveGroup();

		// AI 讲解大模型
		new Setting(body)
			.setName("AI 讲解大模型")
			.setDesc("AI 讲解功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(plugin.settings.explainModelGroupId);
				dropdown.onChange(async (value) => {
					plugin.settings.explainModelGroupId = value;
					await plugin.saveSettings();
				});
			});

		// 翻译大模型
		new Setting(body)
			.setName("翻译大模型")
			.setDesc("翻译功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(plugin.settings.translateModelGroupId);
				dropdown.onChange(async (value) => {
					plugin.settings.translateModelGroupId = value;
					await plugin.saveSettings();
				});
			});

		// 语法拆解大模型
		new Setting(body)
			.setName("语法拆解大模型")
			.setDesc("语法拆解功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				for (const g of plugin.settings.modelGroups) {
					dropdown.addOption(g.id, g.name || g.modelId || g.id);
				}
				dropdown.setValue(plugin.settings.grammarModelGroupId);
				dropdown.onChange(async (value) => {
					plugin.settings.grammarModelGroupId = value;
					await plugin.saveSettings();
				});
			});
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
			this.activeModelListPanel.setCssStyles({ display: "none" });
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
			panel.setCssStyles({ display: "block" });
			void this.refreshModelList(g);
		} else {
			panel.setCssStyles({ display: "none" });
		}
	}

	/** 只渲染当前激活的分组（标题行 + 3 个字段行） */
	private renderActiveGroup(): void {
		const host = this.activeGroupContainer;
		const { plugin, update } = this.ctx;
		if (!host) {
			return;
		}
		host.empty();
		const g = plugin.settings.modelGroups.find(
			(x) => x.id === plugin.settings.activeModelGroupId,
		);
		if (!g) {
			host.createEl("div", {
				text: "未选择分组",
				cls: "nihong-ai-group-empty",
			});
			return;
		}

		// 标题行：名称 + 删除按钮
		new Setting(host)
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
					await plugin.saveSettings();
					this.refreshDropdownOptions();
				});
				// blur 校验空 + 重名，最终一致性更新
				text.inputEl.addEventListener("blur", () => {
					void (async () => {
						const v = text.inputEl.value.trim();
						if (!v) {
							new Notice("分组名称不能为空");
							text.inputEl.value = g.name;
							return;
						}
						// 检查重名（排除自身）
						const dup = plugin.settings.modelGroups.find(
							(x) => x.id !== g.id && x.name === v,
						);
						if (dup) {
							new Notice(`分组名称「${v}」已存在`);
							text.inputEl.value = g.name;
							return;
						}
						g.name = v;
						await plugin.saveSettings();
						// 分组名变更：刷新当前分组下拉框选项 + 重渲染分组编辑区
						update();
					})();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon("trash")
					.setTooltip("删除分组")
					.onClick(async () => {
						if (plugin.settings.modelGroups.length <= 1) {
							new Notice("至少保留一个分组");
							return;
						}
						const s = plugin.settings;
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
						await plugin.saveSettings();
						// 删除分组：重渲染分组编辑区
						update();
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
					await plugin.saveSettings();
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
					panel.setCssStyles({ display: "none" });
					this.activeModelListPanel = panel;
				}
				text.onChange(async (value) => {
					g.modelId = value.trim();
					await plugin.saveSettings();
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
					await plugin.saveSettings();
				});
			});
	}

	/** 在现有分组名基础上确保不重名：若撞名则加 (2)/(3)... 后缀 */
	private uniqueGroupName(base: string): string {
		const groups = this.ctx.plugin.settings.modelGroups;
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
		for (const g of this.ctx.plugin.settings.modelGroups) {
			dropdown.addOption(g.id, g.name || g.modelId || g.id);
		}
		// 恢复选中（若仍存在）
		const exists = this.ctx.plugin.settings.modelGroups.some(
			(g) => g.id === cur,
		);
		dropdown.setValue(
			exists ? cur : (this.ctx.plugin.settings.modelGroups[0]?.id ?? ""),
		);
	}
}

/** 「大模型分组」分组入口：new 一个 ModelGroupEditor 渲染。 */
export function renderModelGroupSection(ctx: SettingsContext, body: HTMLElement): void {
	new ModelGroupEditor(ctx).render(body);
}
