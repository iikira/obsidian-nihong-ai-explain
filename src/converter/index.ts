import { unzipSync } from "fflate";
import { parseEpubStructure, parseChapterHtml } from "./epub";
import { stripRuby } from "./ruby";
import { createImageCollector, xhtmlToMarkdown } from "./htmlToMd";
import { sanitizeFileName } from "../utils";
import type { ConvertResult, EpubStructure, ExtractedImage } from "./types";

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

	// 预计算每章产物文件名，供内部链接改写（href → 产物 md 文件名）
	const chapterFilenames = structure.chapters.map((chapter, index) => {
		const fallbackTitle = chapter.title || `第 ${index + 1} 章`;
		const seq = String(index + 1).padStart(3, "0");
		return `${seq}_${sanitizeFileName(fallbackTitle)}.md`;
	});

	const chapters = structure.chapters.map((chapter, index) => {
		// 1. 去除汉字假名注音
		const cleanHtml = stripRuby(chapter.htmlString);
		// 2. 转 Markdown 并收集图片占位；内部链接改写为产物 md 文件名
		const collector = createImageCollector();
		const linkResolver = buildLinkResolver(structure, chapter, index, chapterFilenames);
		const markdown = xhtmlToMarkdown(cleanHtml, collector, linkResolver);
		// 3. 图片 src 相对于章节 xhtml 文件所在目录解析，回填字节
		//    contentRoot 是 OPF 所在目录；章节 href 是相对 contentRoot 的路径；
		//    图片 src（如 ../image/cover.jpg）是相对章节 xhtml 目录的路径。
		//    故以「contentRoot/章节href的所在目录」为基准解析图片 src。
		const chapterDir = dirOf(joinPath(structure.contentRoot, chapter.href));
		for (const ph of collector.placeholders) {
			const srcPath = joinPath(chapterDir, ph.src);
			const bytes = zip[srcPath];
			if (bytes) {
				if (!images.has(ph.filename)) {
					images.set(ph.filename, { filename: ph.filename, bytes });
				}
			}
		}
		const fallbackTitle = chapter.title || `第 ${index + 1} 章`;
		return {
			title: fallbackTitle,
			filename: chapterFilenames[index],
			markdown,
		};
	});

	return {
		title: structure.title,
		chapters,
		images: [...images.values()],
	};
}

/**
 * 构造内部链接改写器：把 epub 内部链接（如 p-001.xhtml#toc-001）改写为
 * 对应章节产物 md 文件链接（如 005_p-001.md#toc-001）。
 * - 把 href 相对当前章节目录解析为 zip 内路径，匹配 manifest/spine 章节的 zip 路径
 * - 匹配命中：返回「目标章节产物文件名 + 锚点」
 * - 仅锚点（#xxx，无 xhtml）：返回「当前章节产物文件名 + 锚点」
 * - 无匹配：返回 null（保留纯文本）
 */
function buildLinkResolver(
	structure: EpubStructure,
	chapter: { href: string },
	index: number,
	chapterFilenames: string[],
): (href: string) => string | null {
	const chapterDir = dirOf(joinPath(structure.contentRoot, chapter.href));
	const allChapterZipPaths = structure.chapters.map((c) =>
		joinPath(structure.contentRoot, c.href),
	);
	return (href: string): string | null => {
		const [pathPart, anchor = ""] = href.split("#");
		// 仅锚点：指向当前章节内锚点
		if (!pathPart) {
			return anchor ? `${chapterFilenames[index]}#${anchor}` : null;
		}
		// 解析为 zip 内绝对路径
		const targetZipPath = joinPath(chapterDir, pathPart);
		const targetIdx = allChapterZipPaths.indexOf(targetZipPath);
		if (targetIdx >= 0) {
			return anchor
				? `${chapterFilenames[targetIdx]}#${anchor}`
				: chapterFilenames[targetIdx];
		}
		// 兜底：按文件名匹配（部分 epub 用 ./ 前缀或大小写差异）
		const targetBasename = pathPart.split("/").pop() ?? pathPart;
		const fuzzyIdx = allChapterZipPaths.findIndex((p) =>
			p.split("/").pop()?.toLowerCase() === targetBasename.toLowerCase(),
		);
		if (fuzzyIdx >= 0) {
			return anchor
				? `${chapterFilenames[fuzzyIdx]}#${anchor}`
				: chapterFilenames[fuzzyIdx];
		}
		return null;
	};
}

/** 取路径的所在目录（去掉最后一段文件名） */
function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(0, idx) : "";
}

/**
 * 拼接 contentRoot 与相对 src，正确解析 `.`/`..` 段，统一 / 分隔。
 * 例：root="item/xhtml"、src="../image/cover.jpg" → "item/image/cover.jpg"
 *     root=""、src="image/a.jpg" → "image/a.jpg"
 */
function joinPath(root: string, rel: string): string {
	const segments: string[] = [];
	for (const part of (root || "").split("/")) {
		if (part && part !== ".") {
			segments.push(part);
		}
	}
	for (const part of rel.split("/")) {
		if (!part || part === ".") {
			continue;
		}
		if (part === "..") {
			segments.pop();
		} else {
			segments.push(part);
		}
	}
	return segments.join("/");
}

/** 解析章节 XHTML 为 DOM（供需要进一步操作的场景） */
export { parseChapterHtml };
