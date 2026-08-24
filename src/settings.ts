import {
	App,
	DropdownComponent,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type NihongAIExplainPlugin from "./main";

export interface ModelGroup {
	/** 分组唯一 id（uuid 或固定字符串） */
	id: string;
	/** 显示名称 */
	name: string;
	/** API 根地址，例如 https://opencode.ai/zen/v1 */
	apiUrl: string;
	/** 模型 id */
	modelId: string;
	/** API Key，可选 */
	apiKey: string;
}

export interface NihongAIExplainSettings {
	/** 笔记输出目录，相对 vault 根，空字符串=根目录 */
	outputDir: string;
	/** 大模型分组列表 */
	modelGroups: ModelGroup[];
	/** 当前在设置页编辑的分组 id */
	activeModelGroupId: string;
	/** AI 讲解用的大模型分组 id */
	explainModelGroupId: string;
	/** 翻译用的大模型分组 id */
	translateModelGroupId: string;
	/** 系统提示词 */
	systemPrompt: string;
	/** 用户提示词模板，{{word}} 占位 */
	userPromptTemplate: string;
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
}

const DEFAULT_AGENT_MD = `你是一位日语词汇讲解专家。请对用户给出的日语单词，输出一份结构化、准确、富有语感与文化背景的详解。

输出必须严格符合下方模板与规则，禁止输出任何模板之外的寒暄、解释或前后缀。

---

## 输出模板

> 开篇直接以「## 一、词性与含义」起始，**不要**输出任何标题行（如「**「寄る（よる）」详解**」）和其下的分隔线 \`---\`。整篇以「## 一、」开始，以「## 六、语感」段落结束。

## 一、词性与含义

**{单词}（{假名读音}）**

> 单词含汉字时，必须以「汉字（假名）」形式给出读音，例如「寄る（よる）」「夫婦（ふうふ）」「結ぶ（むすぶ）」；单词本身即为假名时仍写出该假名，例如「かる（かる）」。后续各节出现该词的汉字形式时，亦须附上假名读音。

**{词性}**

> 词性须标注完整：①基本类别（名词/动词/形容词/副词/惯用表达等）；②若为动词，必须标明**自动词（不及物）或他动词（及物）**，格式如「动词（自动词，五段）」「动词（他动词，上一段）」；若该动词存在自/他成对词，须在本节末尾用一行说明其配对词，例如：「对应他动词：寄せる」「对应自动词：寄る」；若该词无成对词，注明「无自/他成对词」。

含义：
1. **{义项1}**（{简短释义}）
2. **{义项2}**（{简短释义}）
...（若为单一义项的词/惯用表达，则改为一段话形式说明，并加粗关键词）

> 含义须点明语感核心，例如"费心、顾及他人感受"。

---

## 二、{逐词解析 | 主要用法}

- 若单词为单一短语/惯用表达（如「気を遣う」）：使用「逐词解析」小节，给出拆分表格：

### 逐词解析

| 部分 | 解析 |
|------|------|
| {部分1} | {含义} |
| {部分2} | {含义} |
| ... | ... |

字面即"{字面组合}" → {引申含义}。

- 若单词为多义动词/独立词（如「寄る」）：使用「主要用法」小节，按义项分小节展开：

### 主要用法

#### ① {义项名}

| 搭配 | 含义 |
|------|------|
| {搭配1} | {含义} |
| ... | ... |

例句：
- {日文例句}。（{中文译文}）
- ...

#### ② {义项名}
...（每个义项重复以上结构）

---

## 三、{常用搭配与例句 | 常见复合词与惯用表达}

- 单一义项/惯用表达：使用「常用搭配与例句」：

| 搭配 | 含义 |
|------|------|
| {搭配1} | {含义} |
| ... | ... |

例句：
- {日文例句}。（{中文译文}）
- ...

- 多义独立词：使用「常见复合词与惯用表达」：

| 表达 | 含义 |
|------|------|
| {复合词1}（{读音}） | {含义} |
| ... | ... |

---

## 四、近义词对比

| {词/表达} | 侧重 |
|------|------|
| {近义词1} | {侧重说明} |
| ... | ... |

---

## 五、对比示例（可选，多义/易混词时给出）

| 例句 | 语感 |
|------|------|
| {例句}（{说明}） | {对应词} |
| ... | ... |

> 若与近义词区分度不大，可省略本节。

---

## 六、语感

{对单词的整体语感、文化背景、使用场景、两面性等的说明段落。强调该词在日本人生活/人际交往中的角色，体现温度与人情味，2~4 句。}

---

## 规则

1. **读音**：模板各处假名读音必须准确。**「## 一、词性与含义」节标题行之下必须以「汉字（假名）」形式给出该单词的读音**（例如「寄る（よる）」「夫婦（ふうふ）」「結ぶ（むすぶ）」）；单词本身仅为假名时仍写出该假名（例如「かる（かる）」）。后续各节出现该词的汉字形式时，亦须附上假名读音。
2. **动词变形处理（重点）**：用户输入可能是动词的各种变形（ます形/て形/た形/ない形/可能形/受身形/使役形/命令形/假定形/意向形等）。无论输入为何种变形：
   - 必须先识别并还原其**辞书形（原型）**，全程围绕**原型**展开讲解（词性、含义、用法、例句一律使用原型）。
   - 在「## 一、词性与含义」节首行用一句话说明：「输入「{用户原输入}」为动词「{原型}」的{变形种类}形，以下以原型「{原型}」进行讲解。」之后再写词性与含义。
   - 例如输入「寄りました」→ 写明其为「寄る」的ます形过去式，下文一律用「寄る」。
3. **自/他动词（重点）**：凡涉及动词，必须在词性标注中明确「自动词」或「他动词」；若存在成对词，须在「## 一、」末尾给出对应词（自→他或他→自），并在「## 四、近义词对比」中将该成对词列入并点明侧重差异（如「侧重动作施加于对象，强调致使/改变」）。
4. **多义词**：义项须全面覆盖主要用法，必要时拆为「主要用法」分小节展开。
5. **单一短语**：拆解每个构成词，给出字面 → 引申的推理。
6. **例句**：每个义项/搭配至少给出 1~2 条自然地道的日文例句，并附中文译文；动词一律用原型辞书形或常规活用，避免用变形作为讲解主体。
7. **近义词对比**：至少列出 3~5 个近义/相关表达，点明侧重差异。
8. **语感**：从文化、人际、情感角度收束，避免空泛。
9. **格式**：严格使用 Markdown；表格列名统一为「搭配/表达/词」「含义/侧重」；不输出代码围栏包裹整体内容。
10. **开篇要求**：第一行必须为「## 一、词性与含义」，**禁止**在前面输出单词标题行（如「**「寄る（よる）」详解**」）或任何 \`---\` 分隔线；结尾即「## 六、语感」段落结束。

## 输入

用户将提供一个日语单词（汉字或假名、原型或变形均可）。请按上述模板与规则生成完整详解。`;

export const DEFAULT_SETTINGS: NihongAIExplainSettings = {
	outputDir: "",
	modelGroups: [
		{
			id: "default",
			name: "默认",
			apiUrl: "https://opencode.ai/zen/v1",
			modelId: "hy3-free",
			apiKey: "",
		},
	],
	activeModelGroupId: "default",
	explainModelGroupId: "default",
	translateModelGroupId: "default",
	systemPrompt: DEFAULT_AGENT_MD,
	userPromptTemplate: "请讲解以下日语单词：{{word}}",
	temperature: 0.7,
	maxRetries: 3,
	retryInterval: 2000,
	requestTimeout: 120000,
	targetLanguage: "中文",
	dictFontSize: 0,
};

export class NihongAIExplainSettingTab extends PluginSettingTab {
	plugin: NihongAIExplainPlugin;
	/** 当前分组下拉框引用，分组名变化时实时刷新选项 */
	private activeDropdown: DropdownComponent | null = null;
	/** 当前激活分组的编辑区容器（只显示一个分组），切换下拉框时重渲染 */
	private activeGroupContainer: HTMLDivElement | null = null;

	constructor(app: App, plugin: NihongAIExplainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("笔记输出目录")
			.setDesc("笔记保存到此目录（相对 vault 根）。留空则输出到 vault 根目录。")
			.addText((text) =>
				text
					.setPlaceholder("如 03-explain（留空=根目录）")
					.setValue(this.plugin.settings.outputDir)
					.onChange(async (value) => {
						this.plugin.settings.outputDir = value.trim();
						await this.plugin.saveSettings();
					})
			);

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
							apiUrl: "https://opencode.ai/zen/v1",
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

		// ====== 提示词与采样 ======

		new Setting(containerEl)
			.setName("用户提示词模板")
			.setDesc("{{word}} 会被替换为选中的文字。")
			.addText((text) =>
				text
					.setPlaceholder("请讲解以下日语单词：{{word}}")
					.setValue(this.plugin.settings.userPromptTemplate)
					.onChange(async (value) => {
						this.plugin.settings.userPromptTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("系统提示词")
			.setDesc("作为 system message 发送给大模型。默认为日语词汇讲解 agent 模板，可自行修改。")
			.addTextArea((text) => {
				text
					.setPlaceholder("系统提示词…")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 16;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "monospace";
			});

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

		new Setting(containerEl)
			.setName("使用方法")
			.setDesc(
				"请将 Yomitan 格式 zip（含 term_bank_*.json）复制到本插件目录后，点击下方「导入」。",
			)
			.addButton((btn) =>
				btn
					.setButtonText("打开插件目录")
					.onClick(() => {
						// 移动端：无法打开系统资源管理器，Notice 显示路径供用户复制
						if (Platform.isMobileApp) {
							const rel = this.plugin.getPluginDirRelative() ?? "(未知)";
							new Notice(
								`移动端无法直接打开目录，请用文件管理器把 zip 复制到: vault/${rel}/`,
								12000,
							);
							return;
						}
						// 桌面端：Electron shell.openPath 打开资源管理器
						const dir = this.plugin.getPluginDir();
						if (!dir) {
							new Notice("无法获取插件目录（需桌面端）");
							return;
						}
						try {
							// 动态 require 避开 esbuild 静态分析
							const dynamicRequire = new Function(
								"return typeof require !== 'undefined' ? require : undefined",
							)() as ((m: string) => unknown) | undefined;
							if (!dynamicRequire) {
								new Notice("当前环境不支持打开目录，路径: " + dir, 10000);
								return;
							}
							const fs = dynamicRequire("node:fs") as {
								existsSync: (p: string) => boolean;
							};
							if (!fs.existsSync(dir)) {
								new Notice(`插件目录不存在: ${dir}`);
								return;
							}
							const electron = dynamicRequire("electron") as {
								shell?: { openPath?: (p: string) => void };
							};
							const shell = electron?.shell;
							if (shell && typeof shell.openPath === "function") {
								void shell.openPath(dir);
							} else {
								new Notice("无法打开资源管理器，请手动访问: " + dir, 10000);
							}
						} catch (e) {
							new Notice(
								`打开目录失败: ${e instanceof Error ? e.message : String(e)}`,
								8000,
							);
						}
					}),
			);

		const dictStatusSetting = new Setting(containerEl)
			.setName("词典状态")
			.setDesc("检测中…");

		const refreshDictStatus = async (): Promise<void> => {
			const mgr = this.plugin.dictionaryManager;
			if (!mgr || !mgr.isReady) {
				dictStatusSetting.setDesc("词典未初始化");
				return;
			}
			const imported = await mgr.isImported();
			if (!imported) {
				dictStatusSetting.setDesc("未导入词典");
				return;
			}
			const dicts = await mgr.getDictionaries();
			dictStatusSetting.setDesc(
				`已导入 ${dicts.length} 部词典: ${dicts.map((d) => d.title).join(", ")}`,
			);
		};
		void refreshDictStatus();

		new Setting(containerEl)
			.setName("导入词典")
			.setDesc("扫描插件目录下的 zip 文件并导入到 IndexedDB。")
			.addButton((btn) =>
				btn
					.setButtonText("导入")
					.setCta()
					.onClick(async () => {
						const mgr = this.plugin.dictionaryManager;
						if (!mgr) {
							new Notice("词典管理器未初始化");
							return;
						}
						btn.setButtonText("导入中…").setDisabled(true);
						try {
							await mgr.importFromPluginDir();
							await refreshDictStatus();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`导入失败: ${msg}`, 8000);
							console.error("[nihong-ai] 词典导入失败:", e);
						} finally {
							btn.setButtonText("导入").setDisabled(false);
						}
					}),
			);

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

	/** 清空激活分组编辑容器并重新渲染当前激活分组 */
	private rerenderActiveGroup(): void {
		if (!this.activeGroupContainer) {
			return;
		}
		this.activeGroupContainer.empty();
		this.renderActiveGroup();
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
			.setName(g.name || `(未命名 ${g.id})`)
			.setDesc("当前激活分组")
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
			.setClass("nihong-ai-group-field")
			.addText((text) => {
				text.setPlaceholder("https://api.example.com/v1");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.apiUrl);
				text.onChange(async (value) => {
					g.apiUrl = value.trim();
					await this.plugin.saveSettings();
				});
			});

		// 模型 id
		new Setting(host)
			.setName("模型 id")
			.setClass("nihong-ai-group-field")
			.addText((text) => {
				text.setPlaceholder("如 gpt-4o / hy3-free / deepseek-v4");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.modelId);
				text.onChange(async (value) => {
					g.modelId = value.trim();
					await this.plugin.saveSettings();
				});
			});

		// API Key
		new Setting(host)
			.setName("API Key")
			.setDesc("若端点需要鉴权则填入，无需可留空。")
			.setClass("nihong-ai-group-field")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("留空=不发送 Authorization 头");
				text.inputEl.classList.add("nihong-ai-group-input");
				text.setValue(g.apiKey);
				text.onChange(async (value) => {
					g.apiKey = value;
					await this.plugin.saveSettings();
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
