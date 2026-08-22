/** Yomitan term_bank_*.json 中每条词条的原始元组格式 */
export type RawTermEntry = [
	string, // 0: expression (kanji or kana)
	string, // 1: reading (kana)
	string, // 2: definition tags (space separated)
	string, // 3: rules (space separated)
	number, // 4: popularity/score
	...unknown[] // 5+: glossary content (string | StructuredContent | array)
];

/** Yomitan tag_bank_*.json 中每条标签的原始元组格式 */
export type RawTagEntry = [
	string, // 0: name
	string, // 1: category
	number, // 2: order
	string, // 3: notes
	number, // 4: score
	string // 5: display short form
];

/** Yomitan index.json 元数据 */
export interface DictionaryMeta {
	title: string;
	format: number;
	revision?: string;
	sequenced?: boolean;
	author?: string;
	url?: string;
	description?: string;
	attribution?: string;
}

/** 写入 IndexedDB 的处理后的词条 */
export interface ProcessedTerm {
	expression: string;
	reading: string;
	tags: string[];
	rules: string[];
	score: number;
	glossary: unknown[];
	dictionary: string;
}

/** 写入 IndexedDB 的处理后的标签 */
export interface ProcessedTag {
	name: string;
	category: string;
	order: number;
	notes: string;
	score: number;
	short: string;
	dictionary: string;
}

/** Yomitan 结构化内容（新版 type-based 格式，仍兼容旧版 tag-based） */
export type StructuredContent =
	| { type: "text"; text: string }
	| { type: "structured"; content: ContentNode }
	| { type: "link"; href: string; text?: string; content?: ContentNode }
	| { type: "image"; path: string; title?: string; width?: number; height?: number }
	| { type: "audio"; path: string; title?: string }
	| { type: "footnote"; content?: ContentNode; reference?: string }
	| { type: "quote"; content?: ContentNode }
	| { type: "deinflection"; variant?: string; reasons?: unknown[] }
	| { type: "example"; content?: ContentNode }
	| { tag: string; content?: ContentNode; data?: Record<string, string>; href?: string; lang?: string; title?: string };

export type ContentNode =
	| string
	| StructuredContent
	| ContentNode[];

/** 变形还原候选 */
export interface DeinflectionResult {
	term: string;
	rules: number;
	reasons: string[];
}

/** 查询返回的最终结果 */
export interface LookupResult extends ProcessedTerm {
	deinflectionReasons?: string[];
}
