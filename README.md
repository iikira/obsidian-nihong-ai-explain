# obsidian-nihong-ai-explain

一个 Obsidian 插件：选中一段日文文字，在选区下方弹出按钮「AI 讲解」，点击后调用大模型生成讲解笔记，自动保存为 `<输出目录>/<选中文字>.md`。

## 功能

- 选中文字 → 选区下方浮动按钮「AI 讲解」（同时支持编辑器右键菜单「AI 讲解此词」与命令面板「AI 讲解选中文字」）
- **AI 讲解采用 tool-call 流程**：大模型讲解前先调用 `search_dictionary` 工具查询 MOJI 词典（动词/形容词等变形必须用原型查询），拿到释义、声调、词性等参考信息后再生成讲解；讲解首行标注声调，格式 `**{单词}（{假名读音}）{声调}**`
- 讲解笔记输出保存为 `<outputDir>/<word>.md`；若已存在则提示并跳过
- 系统提示词与翻译提示词内置为常量（不可自定义）
- 调用过程在控制台输出 token 消耗诊断（输入/输出/思考/合计）

## 安装

### 手动构建

```bash
npm install
npm run build
```

把 `dist/` 目录整个复制为 `<vault>/.obsidian/plugins/nihong-ai-explain/`（其中已包含 `main.js`、`manifest.json`、`styles.css`），然后在 Obsidian 的 `Settings → Community plugins` 中启用「日语 AI 讲解」。

## 配置

在 `Settings → 日语 AI 讲解`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 笔记输出目录 | （空） | 相对 vault 根，留空 = 根目录 |
| 大模型分组 | 见下 | 可配置多组（API 地址 / 模型 id / API Key） |
| AI 讲解大模型 | 默认分组 | AI 讲解（流式 tool-call）使用此分组 |
| 翻译大模型 | 默认分组 | 翻译功能使用此分组 |
| 温度 | `0.7` | |
| 最大重试次数 | `3` | |
| 重试间隔 | `2000` ms | |
| 单次请求超时 | `120000` ms | |
| 翻译目标语言 | `中文` | |
| MOJI Device ID | （空） | MOJI 词典查询用，留空则请求时不带 `X-Moji-Device-Id` 等头 |
| MOJI Token | （空） | MOJI 词典查询用，留空则请求时不带 `X-Moji-Session-Id` / `X-Moji-Token` 头 |

默认大模型分组：API 地址 `https://opencode.ai/zen/v1`，模型 `hy3-free`，API Key 留空（不发 `Authorization` 头）。

## 使用

1. 在任意笔记中选中一段日文文字
2. 选区下方出现「AI 讲解」按钮，点击它（或使用右键菜单 / 命令面板）
3. 状态栏出现 `正在生成…` 提示
4. 完成后提示 `已生成: <path>`，并在配置目录下创建 `<word>.md`

## AI 讲解流程说明

- **流式 tool-call 循环**：由于所用的端点在非流式模式下不返回 `tool_calls` 字段，AI 讲解采用流式 SSE 请求，逐块解析 `tool_calls` 分片。
- 每轮模型可发起 `search_dictionary(word)` 工具调用（须用原型 / 辞书形），插件本地查询 MOJI 词典并把结果回灌给模型；模型拿到结果后生成最终讲解。最多 6 轮，超过则去掉 tools 兜底强制生成。
- 最终讲解首行标注声调（如 `⓪` `①` `②`），声调取自 MOJI 词典返回，无则留空，不臆造。
- 控制台输出每轮及合计的 token 消耗（输入 / 输出 / 思考 / 合计）。

## 说明

- AI 讲解走流式请求；翻译走非流式请求
- 端点使用 `requestUrl`（MOJI 词典查询）与 `fetch`（流式 AI 讲解）走 Obsidian 网络层，桌面端与移动端均可用
- 文件名去除 Windows 非法字符（`\ / : * ? " < > |`），空白转为 `_`
- 大模型响应中的 `reasoning_content` 若非空，仅打印 `console.warn`，不影响输出
