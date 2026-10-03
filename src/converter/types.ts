/** epub 内一个章节（按 spine 顺序解析） */
export interface Chapter {
	/** manifest 中该章节条目的 id */
	id: string;
	/** 章节相对 contentRoot 的路径（manifest href） */
	href: string;
	/** 章节原始 XHTML 字符串 */
	htmlString: string;
	/** 章节标题：优先 TOC，其次 manifest 文件名，最后兜底章节序号 */
	title: string;
}

/** epub 基础结构信息 */
export interface EpubStructure {
	/** OPF 所在目录（相对 epub 根），用于解析 manifest href */
	contentRoot: string;
	/** 书名 */
	title: string;
	/** 作者（可能为空） */
	author: string;
	/** 按 spine 阅读顺序排列的章节 */
	chapters: Chapter[];
}

/** 提取出的图片 */
export interface ExtractedImage {
	/** 相对输出目录（images/xxx）的文件名，已去重 */
	filename: string;
	bytes: Uint8Array;
}

/** convertEpub 的产出 */
export interface ConvertResult {
	/** 书名 */
	title: string;
	/** 每章一个 md 文档 */
	chapters: {
		/** 章节标题 */
		title: string;
		/** 输出的 .md 文件名（已清洗） */
		filename: string;
		/** markdown 内容 */
		markdown: string;
	}[];
	/** 章节引用到的图片 */
	images: ExtractedImage[];
}
