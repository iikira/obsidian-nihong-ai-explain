# Nihong AI explaination 霓虹AI讲解

一个 Obsidian 插件。选中一段日文文字，在选区下方弹出按钮，点击后调用大模型生成讲解笔记，自动保存为 `<输出目录>/<选中文字>.md`；同时支持语法拆解、翻译、离线查词典（含声调）与朗读。

## 依赖

为了更好的使用本插件，需要先安装并启用 [Lexis](https://community.obsidian.md/plugins/lexis) 插件。

## 功能

- 选中文字 → 选区下方浮动按钮「AI 讲解 / 语法拆解 / 翻译 / 查词典 / 朗读」（同时支持编辑器右键菜单与命令面板）
- **AI 讲解**：调用大模型，生成结构化讲解笔记
- **语法拆解**：调用大模型，对日语句子/短语做逐词拆解与语法点讲解，保存为笔记
- **翻译**：调用大模型，结果以浮动卡片展示
- **查词典**：离线 Yomitan 词典，弹窗展示释义、例句、声调（圆圈数字 `⓪①②…`）
- **朗读**：支持多引擎（Google / Edge / Windows 系统语音），支持调整语速
- **epub 转 md**：右键 `.epub` 文件 → 转换为 Markdown 文件

## 配置

在 `Settings → Nihong AI explaination`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 单词解析输出目录 | （空） | 单词解析保存到此目录 |
| 语法拆解输出目录 | （空） | 语法拆解笔记保存到此目录 |
| 大模型分组 | （空） | 可配置多组 OpenAI 兼容 API 地址 / 模型 id / API Key |
| 朗读引擎 | `google` | `google`/ `windows`（仅 Windows 系统可用，需安装日文语音包） |

配置完成后，在 [Lexis](https://community.obsidian.md/plugins/lexis) 插件的设置页面的 `词典与词库来源` 章节，也分别对应的配置上 `单词解析输出目录` 和 `语法拆解输出目录`。

### 离线词典

设置页「离线词典」区块，一个按钮安装/更新两本词典：

- **Jitendex**：日语通用词典（释义、例句、词性）。
- **JMnedict**：日语专有名词词典（人名、地名、公司名等 66 万余条）。

两本独立存储，更新一本不影响另一本。查词典时两本同时检索，相同释义去重，人名/地名等来自 JMnedict。专有名词分类标签已中文化，Jitendex 词性标签可在「词典使用方法」入口查看中文解释。

词典源：[Jitendex](https://jitendex.org/pages/downloads.html)、[JMnedict](https://github.com/yomidevs/jmdict-yomitan)。

声调数据来自 kanjium [accents.txt](https://github.com/mifunetoshiro/kanjium/blob/master/data/source_files/raw/accents.txt)。

## 使用

### AI 讲解

1. 在任意笔记中选中一段日文文字
2. 选区下方出现按钮，点击「AI 讲解」（或右键菜单 / 命令面板）
3. 完成后在单词解析输出目录下创建 `<word>.md`

### 语法拆解

1. 选中一个日语句子或短语
2. 点击「语法拆解」（或右键菜单 / 命令面板）
3. 完成后在语法拆解输出目录下创建 `<句子>.md`，含整体含义、逐词解析、关键语法点、相似改写与整句语感

### 翻译 / 查词典 / 朗读

选中文字后点对应按钮即可。查词典弹窗展示词头、声调、义项、例句；朗读支持长文本分片与缓存。

### epub 转 md

在文件管理器右键 `.epub` 文件 → 「转换为 md」，产物在同层 `<文件名>/` 目录下，每章一个 `.md`，插图提取到 `<文件名>/images/`。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # esbuild watch 模式 -> dist/
npm run build      # tsc 类型检查 + esbuild 生产打包 -> dist/
npm run typecheck  # 仅 tsc -noEmit -skipLibCheck
npm run test       # esbuild 编译 test/*.test.ts -> test-dist/ 后 node --test
```
