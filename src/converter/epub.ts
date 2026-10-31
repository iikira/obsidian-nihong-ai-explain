import { unzipSync } from "fflate";
import type { Chapter, EpubStructure } from "./types";

/** 用 DOMParser 解析一段 XML/HTML 字符串，返回 documentElement */
function parseXml(xml: string): Element {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	// 解析失败时 DOMParser 会产出 <parsererror>，这里粗略判断
	if (doc.querySelector("parsererror")) {
		throw new Error("XML 解析失败");
	}
	return doc.documentElement;
}

/** 读取容器信息：返回 OPF 路径（相对 epub 根）及其所在目录 */
function parseContainer(zip: Record<string, Uint8Array>): {
	opfPath: string;
	contentRoot: string;
} {
	const container = getText(zip, "META-INF/container.xml");
	const root = parseXml(container);
	const rootfile = root.querySelector("rootfile");
	if (!rootfile) {
		throw new Error("container.xml 中未找到 rootfile");
	}
	const opfPath = rootfile.getAttribute("full-path") ?? "";
	if (!opfPath) {
		throw new Error("container.xml rootfile 缺少 full-path");
	}
	// OPF 所在目录即内容根目录（去掉 OPF 文件名）
	const idx = opfPath.lastIndexOf("/");
	const contentRoot = idx > 0 ? opfPath.slice(0, idx) : "";
	return { opfPath, contentRoot };
}

/** 解析 OPF 的 metadata：书名与作者（兼容 dc: 命名空间前缀） */
function parseOpfMetadata(pkg: Element): { title: string; author: string } {
	const title =
		Array.from(pkg.querySelectorAll("metadata *"))
			.find((e) => e.localName === "title")
			?.textContent?.trim() ?? "";
	// 作者可能是 dc:creator，带命名空间前缀，用本地名匹配
	const author =
		Array.from(pkg.querySelectorAll("metadata *"))
			.find((e) => e.localName === "creator")
			?.textContent?.trim() ?? "";
	return { title, author };
}

/** 解析 OPF：manifest（id→href）与 spine（idref 顺序） */
function parseOpf(zip: Record<string, Uint8Array>, opfPath: string): {
	manifest: Map<string, string>;
	spine: string[];
	title: string;
	author: string;
} {
	const pkg = parseXml(getText(zip, opfPath));
	const manifest = new Map<string, string>();
	for (const item of Array.from(pkg.querySelectorAll("manifest > item"))) {
		const id = item.getAttribute("id");
		const href = item.getAttribute("href");
		if (id && href) {
			manifest.set(id, href);
		}
	}
	const spine: string[] = [];
	for (const ref of Array.from(pkg.querySelectorAll("spine > itemref"))) {
		const idref = ref.getAttribute("idref");
		if (idref) {
			spine.push(idref);
		}
	}
	return { manifest, spine, ...parseOpfMetadata(pkg) };
}

/**
 * 解析 epub 结构。
 * 使用 fflate 解压为文件名→字节的映射（模式同 dictionary/manager），
 * 再以 DOMParser 解析 container.xml / OPF / TOC，按 spine 顺序产出章节。
 */
export function parseEpubStructure(zip: Record<string, Uint8Array>): EpubStructure {
	const { opfPath, contentRoot } = parseContainer(zip);
	const { manifest, spine, title, author } = parseOpf(zip, opfPath);

	const chapters: Chapter[] = [];
	const tocTitles = readTocTitles(zip, contentRoot, manifest);

	spine.forEach((idref, index) => {
		const href = manifest.get(idref);
		if (!href) {
			return;
		}
		const htmlString = getText(zip, joinPath(contentRoot, href));
		const title = tocTitles.get(idref) ?? fileNameOf(href) ?? `第 ${index + 1} 章`;
		chapters.push({ id: idref, href, htmlString, title });
	});

	return { contentRoot, title, author, chapters };
}

/** 拼接相对路径（内容根 + manifest href），正确解析 `.`/`..` 段，统一 / 分隔。
 *  与 src/converter/index.ts 的 joinPath 行为一致（含 `..` 的 href 才能正确解析到上层目录）。 */
function joinPath(root: string, href: string): string {
	const segments: string[] = [];
	for (const part of (root || "").split("/")) {
		if (part && part !== ".") {
			segments.push(part);
		}
	}
	for (const part of href.split("/")) {
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

/** 从 href 提取无扩展名文件名，作为章节标题兜底 */
function fileNameOf(href: string): string | undefined {
	const name = href.split("/").pop() ?? "";
	return name.replace(/\.(x?html?)$/i, "") || undefined;
}

/** 读取 TOC（优先 nav，其次 NCX），返回 idref → 标题 映射 */
function readTocTitles(
	zip: Record<string, Uint8Array>,
	contentRoot: string,
	manifest: Map<string, string>,
): Map<string, string> {
	const result = new Map<string, string>();

	// 优先取 nav 文档（EPUB3 导航）
	const navId = [...manifest.keys()].find((id) => {
		const href = manifest.get(id) ?? "";
		return /nav\.x?html?$/i.test(href);
	});
	if (navId) {
		try {
			const href = manifest.get(navId)!;
			const doc = parseHtmlDoc(getText(zip, joinPath(contentRoot, href)));
			for (const a of Array.from(doc.querySelectorAll("nav li a"))) {
				const hrefAttr = a.getAttribute("href") ?? "";
				const title = a.textContent?.trim() ?? "";
				if (!title || !hrefAttr) {
					continue;
				}
				const targetId = resolveTocTarget(hrefAttr, manifest);
				if (targetId && !result.has(targetId)) {
					result.set(targetId, title);
				}
			}
			if (result.size > 0) {
				return result;
			}
		} catch {
			// 解析失败则回退 NCX
		}
	}

	// 回退 NCX
	const ncxId = [...manifest.keys()].find((id) => {
		const href = manifest.get(id) ?? "";
		return /\.ncx$/i.test(href);
	});
	if (ncxId) {
		try {
			const href = manifest.get(ncxId)!;
			const doc = parseXml(getText(zip, joinPath(contentRoot, href)));
			for (const np of Array.from(doc.querySelectorAll("navPoint"))) {
				const src = np.querySelector("content")?.getAttribute("src") ?? "";
				const title = np.querySelector("navLabel > text")?.textContent?.trim() ?? "";
				if (!title || !src) {
					continue;
				}
				const targetId = resolveTocTarget(src, manifest);
				if (targetId && !result.has(targetId)) {
					result.set(targetId, title);
				}
			}
		} catch {
			// 忽略 TOC 解析失败
		}
	}
	return result;
}

/** 从 TOC 链接解析目标 manifest id */
function resolveTocTarget(href: string, manifest: Map<string, string>): string | undefined {
	const path = href.split("#")[0].replace(/^\.\//, "");
	for (const [id, mHref] of manifest) {
		if (normalize(mHref) === normalize(path)) {
			return id;
		}
	}
	// 未精确匹配，尝试文件名匹配
	const name = path.split("/").pop();
	for (const [id, mHref] of manifest) {
		if (mHref.split("/").pop() === name) {
			return id;
		}
	}
	return undefined;
}

function normalize(p: string): string {
	return p.replace(/^\.\//, "");
}

/** 读取 zip 内文本；找不到则抛错 */
function getText(zip: Record<string, Uint8Array>, path: string): string {
	const entry = zip[path] ?? zip[`./${path}`] ?? zip[path.replace(/^\.\//, "")];
	if (!entry) {
		throw new Error(`epub 内找不到文件: ${path}`);
	}
	return new TextDecoder().decode(entry);
}

/** 用 HTML 解析器解析导航/章节（nav 是 HTML，需宽松解析） */
function parseHtmlDoc(html: string): Document {
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (doc.querySelector("parsererror")) {
		throw new Error("HTML 解析失败");
	}
	return doc;
}

/**
 * 轻量读取 epub 的书名与作者（只解析 container + OPF 的 metadata，
 * 不解析 manifest/spine/TOC，供视图快速显示用）。
 */
export function extractEpubMetadata(
	buffer: ArrayBuffer,
): { title: string; author: string } {
	const zip = unzipSync(new Uint8Array(buffer));
	const { opfPath } = parseContainer(zip);
	const pkg = parseXml(getText(zip, opfPath));
	return parseOpfMetadata(pkg);
}

