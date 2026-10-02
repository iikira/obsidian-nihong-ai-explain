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
```

There is no test suite. `npm run build` runs the TypeScript typecheck first, so it is the closest thing to "verify it compiles". Output goes to `dist/` (`main.js`, `manifest.json`, `styles.css`); copy that whole directory to `<vault>/.obsidian/plugins/nihong-ai-explain/` to install.

## Architecture

Entry point is `src/main.ts` — the `NihongAIExplainPlugin` class wires everything together on `onload()` and holds the orchestration logic (AI 讲解 tool loop, translate, lookup).

- **`src/main.ts`** — plugin lifecycle, command palette + editor context-menu registration, model API calls, and the four actions. Owns the shared network helpers.
  - **AI 讲解** (`explain()`) uses a **streaming SSE tool-call loop** (`runExplainToolLoop` → `callStreamRound` → `parseStream`): the model may call `search_dictionary` (must use the dictionary form of verbs/adjectives); the plugin executes the query locally via `dispatchTool`, feeds the result back as a `tool` message, and repeats. Max `MAX_TOOL_ROUNDS = 6`; beyond that, tools are stripped and content is forced. Result note is saved as `<outputDir>/<word>.md` (skipped if the file already exists). Per-round and cumulative token usage is logged to the console.
  - **翻译** (`translate()`) uses a **non-streaming** `requestUrl` call (`callModelWithRetry`), rendered in `TranslateCard`, cached in `LRUTranslateCache`.
  - **查词典** (`lookup()`) queries the offline Yomitan DB via `DictionaryManager`, rendered in `DictionaryPopup`.
  - **朗读** (`speakText()`) delegates to the TTS module.
  - Re-entry guard: `tryStartTask`/`finishTask` keys on `${actionId}::${text}` so the same action+text can't run concurrently.
  - `buildDisableThinking(model)` disables model reasoning — `{ thinking: { type: "disabled" } }` for `deepseek-v4`, else `{ reasoning_effort: "none" }`.
- **`src/settings.ts`** — settings interface, `DEFAULT_SETTINGS`, and the settings tab UI. Manages configurable **model groups** (apiUrl/modelId/apiKey) with separate assignments for explain vs translate; `outputDir`, temperature, retries, `mojiDeviceId`/`mojiToken`, dict font size, TTS rate, `disableLexisPill`.
- **`src/prompts.ts`** — built-in system prompts as constants (not user-editable): `EXPLAIN_SYSTEM_PROMPT` (a strict Markdown template for the study note — first line must be `## 一、词性与含义`, accent shown as `⓪①②…`, must come from the dictionary tool, never invented), `TRANSLATE_SYSTEM_PROMPT(target)`.
- **`src/mojidict.ts`** — the live MOJI online dictionary tool path used by AI 讲解. `MOJI_TOOL_SCHEMA` (tool definition for `search_dictionary`), `searchMojidict()` (GET `api.mojidict.com`, only sends `X-Moji-*` headers when deviceId/token set), `formatMojiReference()`, and `dispatchTool()` which routes a model tool-call to the local implementation.
- **`src/pill.ts`** — `SelectionPill` floating button controller. Injects buttons into the Lexis extension's `.lexis-sel-pill` when present; otherwise falls back to its own `.nihong-ai-pill`. On mobile it positions fixed at 100px from the bottom, centered (desktop follows the selection). The `disableLexisPill` toggle suppresses Lexis's own pill entirely.
- **`src/translateCard.ts`** — floating translation card (loading/result/error states). **`src/popupUtils.ts`** — `positionCard()` (position a card near the selection rect, flip above when it would overflow) and `centerRect()` fallback.
- **`src/translateCache.ts`** — LRU map persisted to `localStorage` (debounced writes), capacity 1024.
- **`src/tts/index.ts`** — Japanese TTS via Google Translate `translate_tts` (ja, `client=tw-ob`). Splits long text into ≤200-char segments, LRU caches blob URLs (capacity 128), plays with `Audio`, supports rate and stop.
- **`src/dictionary/`** — offline Yomitan-format dictionary lookups stored in **IndexedDB** (DB name `nihong-ai-dict`).
  - `manager.ts` — `DictionaryManager`: imports a Yomitan `.zip` from the plugin directory (unzips with `fflate`), parsing `index.json`, `term_bank_*.json`, `tag_bank_*.json` into object stores; `lookup()` deinflects then matches on expression/reading indexes, validating deinflection rules.
  - `deinflector.ts` — `Deinflector`, BFS deinflection with bitmask rule matching (ported from Yomichan, GPLv3). Data in `data/deinflectData.ts`.
  - `popup.ts` — `DictionaryPopup` renders results, supports cross-reference `?query=` links (relaunches a lookup, reused card position) and strips `<rt>` furigana on copy.
  - `furigana.ts` — aligns expression/reading into `<ruby>` segments.
  - `types.ts` — Yomitan raw/processed types and `ContentNode` (string | structured | array) used for rendering glossary.

## Key conventions

- **Two dictionary paths coexist and must not be confused:** the **MOJI online dictionary** (`src/mojidict.ts`) powers the AI-讲解 tool call, while the **offline Yomitan DB** (`src/dictionary/`) powers the manual 查词典 action.
- AI 讲解 is **streaming** (SSE `fetch`); translation is **non-streaming** (`requestUrl`). Keep them separate.
- Accent marks (声调) in study notes must be taken from the dictionary result, never invented.
- Text is logged with a `[nihong-ai-explain]` / `[nihong-ai]` / `[nihong-ai-explain tts]` prefix for console diagnostics.
- Filenames strip Windows-forbidden chars (`\ / : * ? " < > |`) and collapse whitespace to `_`.
- All UI copy and code comments are in Chinese.
