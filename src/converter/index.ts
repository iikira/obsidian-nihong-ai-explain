import { unzipSync } from "fflate";
import { parseEpubStructure, parseChapterHtml } from "./epub";
import { stripRuby } from "./ruby";
import { createImageCollector, xhtmlToMarkdown } from "./htmlToMd";
import { sanitizeFileName } from "../utils";
import type { ConvertResult, ExtractedImage } from "./types";

export type { ConvertResult, Chapter, EpubStructure } from "./types";

/**
 * 把一份 epub 的二进制字节转换成一组 Markdown 文档。
 *
 * 流程：fflate 解压 → 解析 container/OPF/spine/TOC → 按 spine 顺序逐章
 * （先去 ruby 注音 → XHTML 转 Markdown → 收集图片引用）→ 回填图片字节。
 *
 * 纯函数，不触碰 Obsidian API，桌面/移动端皆可运行。
 */
export function convertEpub(
	buffer: ArrayBuffer,
	_baseName: string,
): ConvertResult {
	const zip = unzipSync(new Uint8Array(buffer));
	const structure = parseEpubStructure(zip);

	const images = new Map<string, ExtractedImage>();

	const chapters = structure.chapters.map((chapter, index) => {
		// 1. 去除汉字假名注音
		const cleanHtml = stripRuby(chapter.htmlString);
		// 2. 转 Markdown 并收集图片占位
		const collector = createImageCollector();
		const markdown = xhtmlToMarkdown(cleanHtml, collector);
		// 3. 按 contentRoot 拼接出图片在 zip 中的实际路径，回填字节
		for (const ph of collector.placeholders) {
			const srcPath = joinPath(structure.contentRoot, ph.src);
			const bytes = zip[srcPath] ?? zip[normalize(srcPath)];
			if (bytes) {
				if (!images.has(ph.filename)) {
					images.set(ph.filename, { filename: ph.filename, bytes });
				}
			}
		}
		const fallbackTitle = chapter.title || `第 ${index + 1} 章`;
		// 文件名加零填充序号前缀，保证文件系统按字典序排序即等于章节顺序
		const seq = String(index + 1).padStart(3, "0");
		const filename = `${seq}_${sanitizeFileName(fallbackTitle)}.md`;
		return {
			title: fallbackTitle,
			filename,
			markdown,
		};
	});

	return {
		title: structure.title,
		chapters,
		images: [...images.values()],
	};
}

/** 拼接相对路径（内容根 + 相对路径），统一 / 分隔 */
function joinPath(root: string, rel: string): string {
	const clean = rel.replace(/^\.\//, "");
	return root ? `${root}/${clean}` : clean;
}

function normalize(p: string): string {
	return p.replace(/^\.\//, "");
}

/** 解析章节 XHTML 为 DOM（供需要进一步操作的场景） */
export { parseChapterHtml };
