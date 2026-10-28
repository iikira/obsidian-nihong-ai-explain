/**
 * 缓存联动匹配：翻译缓存与朗读缓存按原文（text）互相命中。
 *
 * 日志面板的两个缓存 tab 互相展示对方的内容——翻译缓存条目若能命中朗读缓存则加朗读按钮，
 * 朗读缓存条目若能命中翻译缓存则展示译文。命中判断是纯函数（按 text 关联两个缓存条目列表），
 * 抽出到此模块便于单测（view 层只负责渲染，匹配逻辑在此测）。
 *
 * 匹配规则：同 text 视为命中。多个同 text 的朗读条目取第一个（最近使用，entries 已按最近使用在前排序）；
 * 翻译缓存同 text 也取第一个。
 */

/** 翻译缓存条目（来自 LRUTranslateCache.entries() 的子集） */
export interface TranslateCacheEntry {
	text: string;
	target: string;
	value: string;
}

/** 朗读缓存条目（来自 getTTSCacheEntries() 的子集） */
export interface TTSCacheEntry {
	text: string;
	engine: string;
	voice: string;
	blobUrl: string;
}

/** 翻译条目 + 命中的朗读 blob URL（null 表示未命中朗读缓存） */
export interface TranslateWithTTS extends TranslateCacheEntry {
	/** 命中朗读缓存的 blob URL，未命中为 null */
	ttsBlobUrl: string | null;
}

/** 朗读条目 + 命中的译文（null 表示未命中翻译缓存） */
export interface TTSWithTranslate extends TTSCacheEntry {
	/** 命中翻译缓存的译文，未命中为 null */
	translation: string | null;
}

/**
 * 给翻译缓存条目附上命中的朗读 blob URL。
 * 按 text 匹配；多个同 text 的朗读条目取第一个（最近使用在前）。
 *
 * @param translateEntries 翻译缓存条目（最近使用在前）
 * @param ttsEntries 朗读缓存条目（最近使用在前）
 */
export function matchTranslateWithTTS(
	translateEntries: TranslateCacheEntry[],
	ttsEntries: TTSCacheEntry[],
): TranslateWithTTS[] {
	// text → blobUrl 索引（同 text 取第一个 = 最近使用）
	const ttsByPath = new Map<string, string>();
	for (const t of ttsEntries) {
		if (!ttsByPath.has(t.text)) {
			ttsByPath.set(t.text, t.blobUrl);
		}
	}
	return translateEntries.map((e) => ({
		...e,
		ttsBlobUrl: ttsByPath.get(e.text) ?? null,
	}));
}

/**
 * 给朗读缓存条目附上命中的译文。
 * 按 text 匹配；多个同 text 的翻译条目取第一个（最近使用在前）。
 *
 * @param ttsEntries 朗读缓存条目（最近使用在前）
 * @param translateEntries 翻译缓存条目（最近使用在前）
 */
export function matchTTSWithTranslate(
	ttsEntries: TTSCacheEntry[],
	translateEntries: TranslateCacheEntry[],
): TTSWithTranslate[] {
	const translateByPath = new Map<string, string>();
	for (const t of translateEntries) {
		if (!translateByPath.has(t.text)) {
			translateByPath.set(t.text, t.value);
		}
	}
	return ttsEntries.map((e) => ({
		...e,
		translation: translateByPath.get(e.text) ?? null,
	}));
}
