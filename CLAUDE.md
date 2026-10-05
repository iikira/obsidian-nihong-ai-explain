# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

An Obsidian plugin (`nihong-ai-explain`) for Japanese learners. Select a Japanese word/sentence, and a floating pill offers: **AI 讲解** (LLM-generated study note saved as a vault note), **翻译** (inline translation card), **查词典** (offline Yomitan dictionary popup), and **朗读** (TTS). Network access goes through Obsidian's `requestUrl`/`fetch` so it works on desktop and mobile (`isDesktopOnly: false`).

## Commands

```bash
npm install        # install deps (fflate, idb, esbuild, obsidian types)
npm run dev        # esbuild watch mode -> dist/ (for live testing)
npm run build      # tsc typecheck + esbuild production bundle -> dist/
npm run typecheck  # tsc -noEmit -skipLibCheck only
npm run test       # esbuild-compile test/*.test.ts -> test-dist/ then node --test
```

Unit tests use Node's built-in `node:test` + `node:assert/strict` (**zero new deps**). `test/build.mjs` esbuild-compiles each `test/*.test.ts` to `test-dist/*.test.cjs` (platform=node, cjs, with `obsidian`/`electron` stubbed via an esbuild plugin and `node:*` kept external). Tests cover **pure functions only** (no DOM/network/IndexedDB): `sanitizeFileName`, `buildDisableThinking`/`CallLogger` (`src/shared.ts`), `AccentDb` (`accents.ts`), `Deinflector` (`deinflector.ts`), `getFuriganaSegments` (`furigana.ts`), `toAccentCircle`/`renderTermEntry` (`src/explain/renderTerm.ts` — extracted from `service.ts` as a pure module), `resolveLink`/`createImageCollector` (`src/converter/htmlToMd.ts` — link-classification + image-collector dedup), and `LRUTranslateCache` (with a Map-backed `localStorage` mock in `test/helpers/mockStorage.ts`). DOM-dependent functions (`stripRuby`/`xhtmlToMarkdown`/`parseEpubStructure` — need `DOMParser`, not in Node) and Obsidian-API/network-streaming functions are not unit-tested.

## Architecture

Entry point is `src/main.ts` — the `NihongAIExplainPlugin` class is a thin **orchestration layer**: it wires the service objects together on `onload()`, registers commands/context-menu/pill actions, and owns the shared re-entry guard. The actual business logic (network calls, dictionary reference injection, popup/card rendering, file saving) lives in per-action **services** under `src/explain/`, `src/translate/`, `src/dictionary/`, which take their config and shared helpers via constructor-injected callbacks.

- **`src/main.ts`** — plugin lifecycle; command palette + editor context-menu + selection pill registration; holds `tryStartTask`/`finishTask` re-entry guard (keyed on `${actionId}::${text}`) and the model-group resolution; delegates the four actions to the services. Each service exposes an `onUnload()` that `main.ts` calls on teardown.
  - `explain()` → `this.explainService.explain()`; `translate()` → `this.translateService.translate()`; `lookup()` → `this.lookupService.lookup()`; `speakText()` → TTS module. Also registers the epub view (`registerView` + `registerExtensions(["epub"], ...)`) and a `file-menu` handler to convert epub → md.
- **`src/converter/`** — epub → Markdown conversion, implemented **browser-safely** (no Node deps, so it runs on desktop and mobile). `epub2md` was evaluated and rejected as a dependency because it needs `jsdom`/`node-html-markdown`/`node:fs` (not available in Obsidian's sandbox).
  - `index.ts` — `convertEpub(buffer, baseName)`: pure pipeline (unzip → parse structure → per-chapter: stripRuby → html→md → collect images). Per-chapter `.md` files + images in `images/`. **Internal links** (`<a href="p-001.xhtml#toc-001">`) are rewritten to the destination chapter's output md filename (e.g. `005_p-001.md#toc-001`) via a `linkResolver` built from precomputed chapter filenames; external links passthrough; `#anchor`-only links point to the current chapter. Image `src` is resolved relative to the chapter xhtml's directory (handling `../`).
  - `epub.ts` — `fflate.unzipSync` + `DOMParser`; parses container.xml → OPF manifest/spine → NCX/nav TOC; `extractEpubMetadata()` reads title/author cheaply for the view.
  - `ruby.ts` — `stripRuby()`: DOM removal of `<rt>`/`<rp>` inside `<ruby>` (keeps base kanji), equivalent to the regex approach of epub-ruby-remover but more robust.
  - `htmlToMd.ts` — `xhtmlToMarkdown()`: DOM → Markdown serializer (headings, p, lists, blockquote, code, tables, img→`images/`, SVG `<image xlink:href>`→`images/`, `a` with internal-link rewriting via optional `linkResolver`). `resolveLink()` (exported, pure) classifies href as external (passthrough) / internal (delegate to resolver) / empty (drop). `createImageCollector()` (exported, pure) dedups filenames via a `usedFilenames` set.
  - `service.ts` — `ConverterService` (constructor-injected like other services): reads epub via `adapter.readBinary`, calls `convertEpub`, writes chapters + images into a same-level `xxx/` folder.
  - `view.ts` — `EpubView extends FileView`: makes `.epub` openable in Obsidian; shows title/author + a「转换为 md」button.
- **`src/explain/service.ts`** — `ExplainService`: the **AI 讲解** action.
  - Single **streaming SSE** call (`callStream` → `parseStream`). Before the call, `buildDictionaryReference(word)` queries the offline Yomitan DB (when loaded) and formats the results to match the popup display (per sense-group: POS tags, ①②③ senses, examples with ruby stripped) into the user prompt as a reference block; if the dictionary isn't loaded the prompt is unchanged. `renderTermEntry` walks the Jitendex structured-content glossary, dropping `attribution`/`rt` nodes. Result note is saved via `resolveTargetPath`/`ensureFolder` as `<outputDir>/<word>.md` (skipped if the file already exists). Token usage and the full user prompt are logged to the console.
- **`src/translate/service.ts`** — `TranslateService`: the **翻译** action. Uses a **streaming SSE** `fetch` call (`callModelWithRetry` → `callModelOnce` → `parseStream`, same as AI 讲解 so the endpoint returns accurate `usage`), rendered in `TranslateCard`, cached in `LRUTranslateCache`. Token usage + call stats are logged via `CallLogger` (same unified format as AI 讲解). **`src/translate/card.ts`** — `TranslateCard` floating card (loading/result/error states). **`src/translate/cache.ts`** — `LRUTranslateCache` LRU map persisted to `localStorage` (debounced writes), capacity 1024.
- **`src/dictionary/lookupService.ts`** — `LookupService`: the **查词典** action. Queries the offline Yomitan DB via `DictionaryManager`, renders in `DictionaryPopup`, and handles cross-reference `?query=` re-lookups.
- **`src/utils/index.ts`** — shared helpers used across actions: `sanitizeFileName`/`resolveTargetPath`/`ensureFolder` (filename/path handling; strips Windows-forbidden chars and collapses whitespace to `_`), `MAX_WORD_LEN`/`FORBIDDEN_NAME_CHARS` constants, and `getSelectionRect()`.
- **`src/shared.ts`** — shared chat/types utilities: `ChatMessage`, `ChatCompletionResponse`, `UsageInfo`, `ToolCall`, `PerfRecord`, `buildDisableThinking(model)` (disables model reasoning — `{ thinking: { type: "disabled" } }` for `deepseek-v4`, else `{ reasoning_effort: "none" }`), and `sleep`.
- **`src/settings.ts`** — settings interface, `DEFAULT_SETTINGS`, and the settings tab UI. Manages configurable **model groups** (apiUrl/modelId/apiKey) with separate assignments for explain vs translate; `outputDir` (folder dropdown via `FolderSuggest`), temperature, retries, dict font size, TTS rate, `disableLexisPill`. The **离线词典** section has a single 「Jitendex 词典」row whose button reads 「安装词典」(first use) / 「更新词典」(already installed) → `DictionaryManager.updateJitendex()`, plus a 「清空词典」row.
- **`src/prompts.ts`** — built-in system prompts as constants (not user-editable): `EXPLAIN_SYSTEM_PROMPT` (a strict Markdown template for the study note — first line must be `## 一、词性与含义`, accent shown as `⓪①②…`, must come from the dictionary reference text, never invented), `TRANSLATE_SYSTEM_PROMPT(target)`.
- **`src/pill.ts`** — `SelectionPill` floating button controller. Injects buttons into the Lexis extension's `.lexis-sel-pill` when present; otherwise falls back to its own `.nihong-ai-pill`. On mobile it positions fixed at 100px from the bottom, centered (desktop follows the selection). The `disableLexisPill` toggle suppresses Lexis's own pill entirely.
- **`src/popupUtils.ts`** — `positionCard()` (position a card near the selection rect, flip above when it would overflow) and `centerRect()` fallback.
- **`src/tts/index.ts`** — Japanese TTS via Google Translate `translate_tts` (ja, `client=tw-ob`). Splits long text into ≤200-char segments, LRU caches blob URLs (capacity 128), plays with `Audio`, supports rate and stop.
- **`src/dictionary/`** — offline Yomitan-format dictionary lookups stored in **IndexedDB** (DB name `nihong-ai-dict`).
  - `manager.ts` — `DictionaryManager`: imports a Yomitan `.zip` (unzips with `fflate`), parsing `index.json`, `term_bank_*.json`, `tag_bank_*.json` into object stores; `lookup()` deinflects then matches on expression/reading indexes, validating deinflection rules. Also manages the **Jitendex source**: `fetchLatestRevision()` reads the GitHub release `tag_name` (`stephenmk/stephenmk.github.io`); `getSourceInfo()` compares installed `revision` vs latest for update detection; `updateJitendex()` is the single install/update entry — if IndexedDB already matches latest it skips, else if the local zip's revision (read via `readLocalZipRevision()`) matches latest it reuses the local zip (skipping the download), otherwise it downloads via `downloadJitendexZip()` (`requestUrl`), then clears IndexedDB and re-imports. `importFromZipBuffer(buf)` is the shared import path.
  - `deinflector.ts` — `Deinflector`, BFS deinflection with bitmask rule matching (ported from Yomichan, GPLv3). Data in `data/deinflectData.ts`.
  - `popup.ts` — `DictionaryPopup` renders results, supports cross-reference `?query=` links (relaunches a lookup, reused card position) and strips `<rt>` furigana on copy. Also renders pitch accent next to the header (circle-number markers `⓪①②…`) when `accents.txt` is present.
  - `accents.ts` — `AccentDb`: loads kanjium `accents.txt` (TSV `expression\treading\tpositions`, including `(副)0,(名)3` part-of-speech-tagged variants) into an in-memory index; `lookup(expression, reading)` returns candidate pitch positions. Loaded by `DictionaryManager.loadAccents()` from the plugin dir at init time.
  - `furigana.ts` — aligns expression/reading into `<ruby>` segments.
  - `types.ts` — Yomitan raw/processed types and `ContentNode` (string | structured | array) used for rendering glossary.

## Key conventions

- **The offline Yomitan DB** (`src/dictionary/`) powers both the manual 查词典 action and (when loaded) the AI 讲解 prompt — explain injects the dictionary lookup result (formatted to match the popup display) into the user prompt instead of a tool-call loop.
- AI 讲解 and 翻译 both use **streaming SSE** `fetch`; their logs share one unified format via `CallLogger` (`src/shared.ts`): `[nihong-ai-explain] token: 输入=X 输出=Y 思考=Z 缓存命中=N(P%)，M 次调用 · 成功 A · 失败 B · 累计 Kms · 终态 成功/失败`. `缓存命中` is the prompt-cache hit token count (`prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`), not the LRU translate cache.
- Accent marks (声调) in study notes must be taken from the dictionary result, never invented.
- Text is logged with a `[nihong-ai-explain]` / `[nihong-ai]` / `[nihong-ai-explain tts]` prefix for console diagnostics.
- Filenames strip Windows-forbidden chars (`\ / : * ? " < > |`) and collapse whitespace to `_`.
- All UI copy and code comments are in Chinese.
- **README 是面向用户的使用说明，不是技术文档**：写/改 `README.md` 时精简实现细节（流式 SSE、IndexedDB、LRU 缓存容量、CallLogger 日志格式、网络层、文件名清洗规则等技术名词一律不写），只写用户能感知的功能与行为。本 `CLAUDE.md` 不受此约束，仍保留完整实现细节供 Claude Code 参考。
