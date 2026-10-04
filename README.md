# obsidian-nihong-ai-explain

一个 Obsidian 插件：**霓虹AI讲解**。选中一段日文文字，在选区下方弹出按钮，点击后调用大模型生成讲解笔记，自动保存为 `<输出目录>/<选中文字>.md`；同时支持翻译、离线查词典（Yomitan 格式，含声调）与朗读。

## 功能

- 选中文字 → 选区下方浮动按钮「AI 讲解 / 翻译 / 查词典 / 朗读」（同时支持编辑器右键菜单与命令面板）
- **AI 讲解**：流式调用大模型，讲解前先查离线词典，命中则把词典结果（含声调、词性、释义、例句）注入用户提示词作为参考，生成结构化讲解笔记；首行标注声调 `**{单词}（{假名}）{声调}**`
- **翻译**：流式调用大模型，结果以浮动卡片展示并 LRU 缓存
- **查词典**：离线 Yomitan 词典（IndexedDB），弹窗展示释义、例句、声调（圆圈数字 `⓪①②…`）
- **朗读**：Google Translate TTS，长文本分片、LRU 缓存、支持语速与停止
- **epub 转 md**：右键 `.epub` 文件 → 转换为 Markdown（去振假名、每章一文件、插图提取到 `images/`）
- 讲解笔记保存为 `<outputDir>/<word>.md`，已存在则跳过

## 安装

### 手动构建

```bash
npm install
npm run build
```

把 `dist/` 目录整个复制为 `<vault>/.obsidian/plugins/nihong-ai-explain/`（其中已包含 `main.js`、`manifest.json`、`styles.css`），然后在 Obsidian 的 `Settings → Community plugins` 中启用「霓虹AI讲解」。

## 配置

在 `Settings → 霓虹AI讲解`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 笔记输出目录 | （空） | 相对 vault 根，留空 = 根目录；支持下拉选择 vault 内文件夹 |
| 大模型分组 | 见下 | 可配置多组（API 地址 / 模型 id / API Key），支持复制 / 新增 / 删除 |
| AI 讲解大模型 | 默认分组 | AI 讲解使用此分组 |
| 翻译大模型 | 默认分组 | 翻译使用此分组 |
| 温度 | `0.7` | |
| 最大重试次数 | `3` | |
| 重试间隔 | `2000` ms | |
| 翻译目标语言 | `中文` | |
| 词典卡片字号 | `0` | 8–32 px，0 = 用 Obsidian 主题默认 |
| 朗读语速 | `1.0` | 0.5–3.0，1.0 = 正常 |
| 禁用 Lexis 悬浮窗 | 关 | 开启后改用本插件自带选区按钮 |

默认大模型分组：API 地址 `https://opencode.ai/zen/v1`，模型 `hy3-free`，API Key 留空（不发 `Authorization` 头）。

### 离线词典

设置页「离线词典」区块：

- **Jitendex 词典**：单按钮，首次点击为「安装词典」（从 Jitendex 官方源下载 `jitendex-yomitan.zip` 并导入 IndexedDB），已安装后变为「更新词典」（检测 GitHub 最新版本号，本地 zip 版本一致则跳过下载，否则清空旧数据重新导入）
- **清空词典**：清空 IndexedDB 中的词典数据

Jitendex 词典源：<https://jitendex.org/pages/downloads.html>（GitHub release：`stephenmk/stephenmk.github.io`）。声调数据来自 kanjium `accents.txt`（构建时自动下载到 `dist/`）。

## 使用

### AI 讲解

1. 在任意笔记中选中一段日文文字
2. 选区下方出现按钮，点击「AI 讲解」（或右键菜单 / 命令面板）
3. 状态栏出现 `正在生成…` 提示
4. 完成后提示 `已生成: <path>`，并在配置目录下创建 `<word>.md`

若离线词典已导入，讲解前会自动查询并把词典参考（词性标签、`①②③` 义项序号、释义、例句，日文例句去振假名与空格）注入提示词，可在控制台看到完整用户提示词日志。

### 翻译 / 查词典 / 朗读

选中文字后点对应按钮即可。翻译结果 LRU 缓存（容量 1024）；查词典弹窗展示词头（振假名对齐）、声调、义项、例句，支持交叉引用跳转；朗读支持长文本分片与缓存。

### epub 转 md

在文件管理器右键 `.epub` 文件 → 「转换为 md」，产物在同层 `<文件名>/` 目录下，每章一个 `.md`（文件名带序号），插图提取到 `<文件名>/images/`。

## AI 讲解流程说明

- **流式 SSE**：AI 讲解与翻译均用流式 `fetch` + SSE（同一端点的流式响应才返回准确的 token `usage`）
- 讲解前查离线词典（Yomitan DB），命中则把词典参考拼进用户提示词；未导入词典时提示词不变
- 讲解首行标注声调（如 `⓪` `①` `②`），取自词典参考，无则留空，不臆造
- 调用日志统一格式（`CallLogger`）：`[nihong-ai-explain] token: 输入=X 输出=Y 思考=Z 缓存命中=N(P%)，M 次调用 · 成功 A · 失败 B · 累计 Kms · 终态 成功`，其中 `缓存命中` 为 prompt token 缓存命中率（兼容 OpenAI `prompt_tokens_details.cached_tokens` 与 DeepSeek `prompt_cache_hit_tokens`）

## 说明

- 端点用 `fetch`（流式 AI 讲解 / 翻译）与 `requestUrl`（TTS、Jitendex 下载、版本检测）走 Obsidian 网络层，桌面端与移动端均可用
- 文件名去除 Windows 非法字符（`\ / : * ? " < > |`），空白转为 `_`
- 大模型响应中的 `reasoning_content` 若非空，仅打印 `console.warn`，不影响输出
- 控制台日志统一前缀：`[nihong-ai-explain]` / `[nihong-ai]` / `[nihong-ai-explain tts]`

## 开发

```bash
npm install        # 安装依赖（fflate, idb, esbuild, obsidian types）
npm run dev        # esbuild watch 模式 -> dist/
npm run build      # tsc 类型检查 + esbuild 生产打包 -> dist/
npm run typecheck  # 仅 tsc -noEmit -skipLibCheck
npm run test       # esbuild 编译 test/*.test.ts -> test-dist/ 后 node --test
```

### 单元测试

用 Node 内置 `node:test` + `node:assert/strict`（零新依赖）。`test/build.mjs` 把每个 `test/*.test.ts` 用 esbuild 编译为 `test-dist/*.test.cjs`（`obsidian`/`electron` 桩成空模块，`node:*` 保持 external）。覆盖纯函数（无 DOM/网络/IndexedDB）：

- `sanitizeFileName`（文件名清洗）
- `buildDisableThinking` / `CallLogger`（思考开关、统一调用日志）
- `AccentDb`（声调索引解析与查询）
- `Deinflector`（动词/形容词变形还原）
- `getFuriganaSegments`（振假名对齐）
- `toAccentCircle` / `renderTermEntry`（声调圆圈标记、Jitendex 释义渲染）
- `LRUTranslateCache`（LRU 缓存，含 localStorage mock）

## License

MIT
