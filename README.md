# obsidian-nihong-ai-explain

一个 Obsidian 插件：选中一段日文文字，在选区下方弹出按钮「AI 讲解」，点击后调用大模型生成讲解笔记，自动保存为 `<输出目录>/<选中文字>.md`。

## 功能

- 选中文字 → 选区下方浮动按钮「AI 讲解」（同时支持编辑器右键菜单「AI 讲解此词」与命令面板「AI 讲解选中文字」）
- 调用大模型（默认 OpenAI 兼容端点 `https://opencode.ai/zen/v1`，模型 `hy3-free`）生成结构化讲解
- 输出保存为 `<outputDir>/<word>.md`；若已存在则提示并跳过
- 系统提示词默认内置日语词汇讲解 agent 模板，可在设置中编辑

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
| 大模型 API 地址 | `https://opencode.ai/zen/v1` | OpenAI 兼容端点根地址 |
| 模型名称 | `hy3-free` | |
| API Key（可选） | （空） | 留空则不发送 `Authorization` 头 |
| 用户提示词模板 | `请讲解以下日语单词：{{word}}` | `{{word}}` 被替换为选中文字 |
| 系统提示词 | （内置 agent 模板） | 可自由编辑 |
| 温度 | `0.7` | |
| 最大重试次数 | `3` | |
| 重试间隔 | `2000` ms | |
| 单次请求超时 | `120000` ms | |

## 使用

1. 在任意笔记中选中一段日文文字
2. 选区下方出现「AI 讲解」按钮，点击它（或使用右键菜单 / 命令面板）
3. 状态栏出现 `正在生成…` 提示
4. 完成后提示 `已生成: <path>`，并在配置目录下创建 `<word>.md`

## 说明

- 端点使用 `requestUrl` 走 Obsidian 网络层，桌面端与移动端均可用
- 文件名去除 Windows 非法字符（`\ / : * ? " < > |`），空白转为 `_`
- 大模型响应中的 `reasoning_content` 若非空，仅打印 `console.warn`，不影响输出
