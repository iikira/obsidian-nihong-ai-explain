import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NihongAIExplainPlugin from "./main";

export interface NihongAIExplainSettings {
	/** 笔记输出目录，相对 vault 根，空字符串=根目录 */
	outputDir: string;
	/** 大模型 API 根地址，例如 https://opencode.ai/zen/v1 */
	apiUrl: string;
	/** 模型名称 */
	modelName: string;
	/** API Key，可选（部分端点不需要） */
	apiKey: string;
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
	/** 词典 zip 路径 */
	dictionaryZipPath: string;
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
	apiUrl: "https://opencode.ai/zen/v1",
	modelName: "hy3-free",
	apiKey: "",
	systemPrompt: DEFAULT_AGENT_MD,
	userPromptTemplate: "请讲解以下日语单词：{{word}}",
	temperature: 0.7,
	maxRetries: 3,
	retryInterval: 2000,
	requestTimeout: 120000,
	targetLanguage: "中文",
	dictionaryZipPath:
		"D:\\obsidian\\jp\\jp\\.obsidian\\plugins\\japanese-popup-dictionary\\jitendex-yomitan.zip",
};

export class NihongAIExplainSettingTab extends PluginSettingTab {
	plugin: NihongAIExplainPlugin;

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

		new Setting(containerEl)
			.setName("大模型 API 地址")
			.setDesc("OpenAI 兼容端点根地址，例如 https://opencode.ai/zen/v1")
			.addText((text) =>
				text
					.setPlaceholder("https://opencode.ai/zen/v1")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("模型名称")
			.setDesc("如 hy3-free")
			.addText((text) =>
				text
					.setPlaceholder("hy3-free")
					.setValue(this.plugin.settings.modelName)
					.onChange(async (value) => {
						this.plugin.settings.modelName = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Key（可选）")
			.setDesc("若端点需要鉴权则填入，无需可留空。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("留空=不发送 Authorization 头")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

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
			.setName("词典 zip 路径")
			.setDesc("Yomitan 格式 zip 的绝对路径（含 term_bank_*.json）。")
			.addText((text) =>
				text
					.setPlaceholder("D:\\...\\jitendex-yomitan.zip")
					.setValue(this.plugin.settings.dictionaryZipPath)
					.onChange(async (value) => {
						this.plugin.settings.dictionaryZipPath = value.trim();
						await this.plugin.saveSettings();
					})
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
				`已导入 ${dicts.length} 部词典: ${dicts.map((d) => d.title).join(", ")}`
			);
		};
		void refreshDictStatus();

		new Setting(containerEl)
			.setName("导入词典")
			.setDesc("从配置的 zip 路径导入到 IndexedDB（首次使用或更新词典时点此）。")
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
						const path = this.plugin.settings.dictionaryZipPath.trim();
						if (!path) {
							new Notice("请先填写词典 zip 路径");
							return;
						}
						btn.setButtonText("导入中…").setDisabled(true);
						try {
							await mgr.importFromZip(path);
							await refreshDictStatus();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`导入失败: ${msg}`, 8000);
							console.error("[nihong-ai] 词典导入失败:", e);
						} finally {
							btn.setButtonText("导入").setDisabled(false);
						}
					})
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
					})
			);
	}
}
