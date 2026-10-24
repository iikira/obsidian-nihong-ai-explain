import {
	DropdownComponent,
	Notice,
	Setting,
} from "obsidian";
import type { SettingsContext } from "./context";
import { ModelSuggest } from "./modelSuggest";
import { bindClearButtonRefresh } from "./outputDir";

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
	/** 三个模型分配下拉框（AI 讲解/翻译/语法拆解），改分组名时同步刷新选项 */
	private explainDropdown: DropdownComponent | null = null;
	private translateDropdown: DropdownComponent | null = null;
	private grammarDropdown: DropdownComponent | null = null;

	constructor(private ctx: SettingsContext) {}

	/**
	 * 渲染整个「大模型分组」区块（当前分组下拉+复制/新增按钮、分组编辑区、三个模型分配下拉）。
	 */
	render(body: HTMLElement): void {
		const { plugin } = this.ctx;
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
						// 局部更新：刷新下拉选项 + 重渲染分组编辑区，不整树重渲染
						// （整树重渲染会重建所有输入框，导致焦点跳到首个输入框触发 FolderSuggest）
						this.refreshDropdownOptions();
						this.rerenderActiveGroup();
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
						// 局部更新：刷新下拉选项 + 重渲染分组编辑区，不整树重渲染
						this.refreshDropdownOptions();
						this.rerenderActiveGroup();
					}),
			)
			.addExtraButton((btn) => {
				btn.setIcon("trash")
					.setTooltip("删除当前分组")
					.onClick(async () => {
						await this.deleteActiveGroup();
					});
			});

		// 分组编辑区容器（只显示当前激活的分组），由 rerenderActiveGroup 维护
		this.activeGroupContainer = body.createDiv();
		this.renderActiveGroup();

		// AI 讲解大模型
		new Setting(body)
			.setName("AI 讲解大模型")
			.setDesc("AI 讲解功能使用此分组的大模型。")
			.addDropdown((dropdown) => {
				this.explainDropdown = dropdown;
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
				this.translateDropdown = dropdown;
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
				this.grammarDropdown = dropdown;
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
	 * 删除当前激活分组（顶部 trash 按钮调用）。
	 * 至少保留一个分组；删除后把各处引用该分组的分配回退到首个分组，再局部刷新。
	 */
	private async deleteActiveGroup(): Promise<void> {
		const s = this.ctx.plugin.settings;
		if (s.modelGroups.length <= 1) {
			new Notice("至少保留一个分组");
			return;
		}
		const g = s.modelGroups.find((x) => x.id === s.activeModelGroupId);
		if (!g) {
			return;
		}
		const fallback = s.modelGroups.find((x) => x.id !== g.id)?.id ?? "";
		const idx = s.modelGroups.indexOf(g);
		s.modelGroups.splice(idx, 1);
		s.activeModelGroupId = fallback;
		if (s.explainModelGroupId === g.id) {
			s.explainModelGroupId = fallback;
		}
		if (s.grammarModelGroupId === g.id) {
			s.grammarModelGroupId = fallback;
		}
		if (s.translateModelGroupId === g.id) {
			s.translateModelGroupId = fallback;
		}
		await this.ctx.plugin.saveSettings();
		// 局部更新：刷新下拉选项 + 重渲染分组编辑区，不整树重渲染
		this.refreshDropdownOptions();
		this.rerenderActiveGroup();
	}

	/** 只渲染当前激活的分组（标题行 + 3 个字段行） */
	private renderActiveGroup(): void {
		const host = this.activeGroupContainer;
		const { plugin } = this.ctx;
		if (!host) {
			return;
		}
		host.empty();
		const g = plugin.settings.modelGroups.find(
			(x) => x.id === plugin.settings.activeModelGroupId,
		);
		if (!g) {
			host.createDiv({ text: "未选择分组" });
			return;
		}

		// 标题行：分组名（纯文本输入，删除按钮在顶部「当前分组」行）
		new Setting(host)
			.setName("分组名")
			.setDesc("大模型分组名")
			.addText((text) => {
				text.setPlaceholder("分组名称");
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
						// 分组名变更：刷新当前分组下拉框选项（局部更新，不整树重渲染——
						// 重渲染会销毁 DOM 导致焦点跳到首个输入框触发 FolderSuggest）
						this.refreshDropdownOptions();
					})();
				});
			});

		// API 地址
		new Setting(host)
			.setName("API 地址")
			.setDesc("大模型 OpenAI 兼容 API 地址, 后缀需带上 /v1")
			.addText((text) => {
				text.setPlaceholder("https://api.example.com/v1");
				text.setValue(g.apiUrl);
				text.onChange(async (value) => {
					g.apiUrl = value.trim();
					await plugin.saveSettings();
					// 端点变了，刷新模型候选（去抖：输入中间态不逐字符发请求）
					this.scheduleModelSuggestRefresh();
				});
			});

		// 模型 id（输入时弹出端点返回的模型候选下拉，可模糊过滤与点选，也可手动输入）
		new Setting(host)
			.setName("模型 id")
			.setDesc("可从下拉选择端点返回的模型，也可手动输入任意模型 id。")
			.addSearch((search) => {
				const apply = async (value: string): Promise<void> => {
					g.modelId = value.trim();
					await plugin.saveSettings();
				};
				search
					.setPlaceholder("deepseek-flash")
					.setValue(g.modelId)
					.onChange((value) => void apply(value));
				// 输入时弹出端点返回的模型候选下拉，可过滤与点选（交互参考单词解析输出目录）
				// ModelSuggest 构造时按当前分组的 apiUrl+apiKey 取列表（命中全局缓存或网络拉取），
				// 实例持有自己的列表，切换/新增分组时旧实例随 DOM 销毁，不会串到别的分组。
				// 点选后 setValue 不会触发 onChange，需在 onPick 里直接保存
				this.modelSuggest = new ModelSuggest(this.ctx.app, search.inputEl, g.apiUrl, g.apiKey, (modelId) => {
					search.setValue(modelId);
					void apply(modelId);
				});
				// 点 × 清除按钮：派发 input 事件触发 onChange 持久化 + Suggest 重新弹出候选
				bindClearButtonRefresh(search);
			});

		// API Key
		new Setting(host)
			.setName("API Key")
			.setDesc("若端点需要鉴权则填入，无需可留空。")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("");
				text.setValue(g.apiKey);
				text.onChange(async (value) => {
					g.apiKey = value;
					await plugin.saveSettings();
					// key 变了，缓存维度变了，刷新模型候选（去抖合并连续输入）
					this.scheduleModelSuggestRefresh();
				});
			});
	}

	/** 当前分组「模型 id」候选下拉实例（API 地址 / API Key 变更时刷新其列表） */
	private modelSuggest: ModelSuggest | null = null;

	/** 模型候选刷新去抖计时器 */
	private modelSuggestRefreshTimer: number | null = null;

	/**
	 * 去抖刷新「模型 id」候选列表：API 地址 / API Key 变更后，等输入停顿 500ms 再按
	 * 最新 apiUrl+apiKey 重新取列表（全局缓存命中则零请求；未命中才发网络请求）。
	 * 去抖避免输入中间态（如逐字符敲 URL）逐次触发请求。
	 */
	private scheduleModelSuggestRefresh(): void {
		if (this.modelSuggestRefreshTimer != null) {
			window.clearTimeout(this.modelSuggestRefreshTimer);
		}
		this.modelSuggestRefreshTimer = window.setTimeout(() => {
			this.modelSuggestRefreshTimer = null;
			const g = this.ctx.plugin.settings.modelGroups.find(
				(x) => x.id === this.ctx.plugin.settings.activeModelGroupId,
			);
			if (g) {
				this.modelSuggest?.refresh(g.apiUrl, g.apiKey);
			}
		}, 500);
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

	/** 重建所有分组下拉框的选项（当前分组 + AI 讲解/翻译/语法拆解分配），
	 * 保留各自的当前选中值。改分组名/增删分组时调用，避免整树重渲染。 */
	private refreshDropdownOptions(): void {
		const groups = this.ctx.plugin.settings.modelGroups;
		const rebuild = (dropdown: DropdownComponent | null, selectedId: string): void => {
			if (!dropdown) {
				return;
			}
			const exists = groups.some((g) => g.id === selectedId);
			// 清空旧 options
			while (dropdown.selectEl.firstChild) {
				dropdown.selectEl.removeChild(dropdown.selectEl.firstChild);
			}
			for (const g of groups) {
				dropdown.addOption(g.id, g.name || g.modelId || g.id);
			}
			dropdown.setValue(exists ? selectedId : (groups[0]?.id ?? ""));
		};
		rebuild(this.activeDropdown, this.ctx.plugin.settings.activeModelGroupId);
		rebuild(this.explainDropdown, this.ctx.plugin.settings.explainModelGroupId);
		rebuild(this.translateDropdown, this.ctx.plugin.settings.translateModelGroupId);
		rebuild(this.grammarDropdown, this.ctx.plugin.settings.grammarModelGroupId);
	}
}

/** 「大模型分组」分组入口：new 一个 ModelGroupEditor 渲染。 */
export function renderModelGroupSection(ctx: SettingsContext, body: HTMLElement): void {
	new ModelGroupEditor(ctx).render(body);
}
