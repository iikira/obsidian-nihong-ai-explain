/** 待回填字节的图片占位 */
export interface ImagePlaceholder {
	/** epub 内原始 src（相对 contentRoot） */
	src: string;
	/** 输出目录相对文件名（images/<filename>） */
	filename: string;
}

/** 图片收集结果 */
interface ImageCollector {
	/** 收集到的图片占位（字节由调用方从 zip 回填） */
	placeholders: ImagePlaceholder[];
	/** 生成唯一的相对引用路径（images/<filename>） */
	resolve(src: string): string;
}

/**
 * 把一章 XHTML 转成 Markdown。
 * 逐节点递归序列化；图片会收集进 collector，md 里用相对路径 images/<file> 引用。
 * 应先对 htmlString 调用 stripRuby() 再去掉注音，再传入本函数。
 */
export function xhtmlToMarkdown(
	htmlString: string,
	collector: ImageCollector,
): string {
	const doc = new DOMParser().parseFromString(htmlString, "text/html");
	if (doc.querySelector("parsererror")) {
		return "";
	}
	const body = doc.body;
	const parts: string[] = [];
	serializeNode(body, parts, collector);
	// 折叠多余空行，首尾去空行
	return normalizeMarkdown(parts.join(""));
}

function serializeNode(
	node: Node,
	out: string[],
	collector: ImageCollector,
): void {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent ?? "";
		if (text) {
			out.push(text);
		}
		return;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) {
		return;
	}
	const el = node as Element;
	const tag = el.localName.toLowerCase();

	switch (tag) {
		case "body":
			for (const child of blockChildren(el)) {
				serializeNode(child, out, collector);
			}
			return;
		// 丢弃无意义元素
		case "head":
		case "script":
		case "style":
		case "nav":
		case "input":
		case "textarea":
		case "noscript":
		case "template":
			return;
		// 标题
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = Number(tag[1]);
			const text = collectText(el);
			if (text.trim()) {
				out.push(`${"#".repeat(level)} ${text.trim()}\n`);
			}
			return;
		}
		case "p": {
			const text = collectInline(el, collector);
			if (text.trim()) {
				out.push(`${text.trim()}\n\n`);
			}
			return;
		}
		case "div":
		case "section":
		case "article":
		case "main": {
			for (const child of blockChildren(el)) {
				serializeNode(child, out, collector);
			}
			return;
		}
		// 列表
		case "ul": {
			for (const li of childrenByName(el, "li")) {
				out.push(`- ${collectInline(li, collector).trim()}\n`);
			}
			out.push("\n");
			return;
		}
		case "ol": {
			let i = 1;
			for (const li of childrenByName(el, "li")) {
				out.push(`${i++}. ${collectInline(li, collector).trim()}\n`);
			}
			out.push("\n");
			return;
		}
		case "li": {
			out.push(collectInline(el, collector).trim());
			return;
		}
		case "blockquote": {
			const inner = collectText(el).trim();
			if (inner) {
				const quoted = inner
					.split("\n")
					.map((l) => `> ${l}`)
					.join("\n");
				out.push(`${quoted}\n\n`);
			}
			return;
		}
		case "pre": {
			const code = (el.textContent ?? "").replace(/\n+$/, "");
			out.push("```\n" + code + "\n```\n\n");
			return;
		}
		case "code": {
			out.push(`\`${el.textContent ?? ""}\``);
			return;
		}
		case "hr": {
			out.push("---\n\n");
			return;
		}
		case "br": {
			out.push("\n");
			return;
		}
		case "img": {
			const src = el.getAttribute("src") ?? "";
			const alt = el.getAttribute("alt") ?? "";
			if (src) {
				out.push(`![${alt || "image"}](${collector.resolve(src)})`);
			}
			return;
		}
		case "a": {
			const href = el.getAttribute("href") ?? "";
			const text = collectInline(el, collector).trim();
			if (text) {
				out.push(`[${text}](${href})`);
			}
			return;
		}
		case "table": {
			serializeTable(el, out, collector);
			return;
		}
		// 内联语义
		case "strong":
		case "b":
		case "em":
		case "i":
		case "u":
		case "span":
		case "sup":
		case "sub":
		case "mark":
		case "small":
		case "label": {
			for (const child of Array.from(el.childNodes)) {
				serializeNode(child, out, collector);
			}
			return;
		}
		// 未知块级：透传子节点
		default: {
			for (const child of Array.from(el.childNodes)) {
				serializeNode(child, out, collector);
			}
			return;
		}
	}
}

/** 收集元素内纯文本（含嵌套，不含块级结构） */
function collectText(el: Element): string {
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** 块级容器子节点：跳过纯空白文本（源格式缩进），保留元素与有内容文本 */
function blockChildren(el: Element): ChildNode[] {
	return Array.from(el.childNodes).filter((n) => {
		if (n.nodeType === Node.TEXT_NODE) {
			return (n.textContent ?? "").trim().length > 0;
		}
		return true;
	});
}

/** 收集元素内联内容（遍历其子节点，避免对元素自身再分派造成递归） */
function collectInline(el: Element, collector: ImageCollector): string {
	const parts: string[] = [];
	for (const child of Array.from(el.childNodes)) {
		serializeNode(child, parts, collector);
	}
	return parts.join("");
}

/** 处理一个单元格 td/th：以 <br> 分隔多行 */
function cellText(el: Element, collector: ImageCollector): string {
	const parts: string[] = [];
	for (const child of Array.from(el.childNodes)) {
		serializeNode(child, parts, collector);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 序列化基础 Markdown 表格 */
function serializeTable(
	table: Element,
	out: string[],
	collector: ImageCollector,
): void {
	const rows: string[][] = [];
	const headerRow: string[] | null = [];

	const processRows = (body: Element) => {
		for (const tr of childrenByName(body, "tr")) {
			const cells = childrenByName(tr, "th").length
				? childrenByName(tr, "th")
				: childrenByName(tr, "td");
			if (cells.length === 0) {
				continue;
			}
			const row = cells.map((c) => cellText(c, collector).replace(/\|/g, "\\|"));
			if (tr.parentElement?.localName === "thead" && headerRow.length === 0) {
				headerRow.push(...row);
			} else {
				rows.push(row);
			}
		}
	};

	const thead = childrenByName(table, "thead")[0];
	const tbody = childrenByName(table, "tbody")[0];
	if (thead) {
		processRows(thead);
	}
	if (tbody) {
		processRows(tbody);
	}
	// 兜底：直接 tr 子元素
	if (headerRow.length === 0 && rows.length === 0) {
		processRows(table);
	}

	const allRows = headerRow.length ? [headerRow, ...rows] : rows;
	if (allRows.length === 0) {
		return;
	}
	const colCount = Math.max(...allRows.map((r) => r.length));
	const pad = (r: string[]) => {
		const arr = [...r];
		while (arr.length < colCount) {
			arr.push("");
		}
		return `| ${arr.join(" | ")} |`;
	};
	out.push(pad(allRows[0]) + "\n");
	out.push(`|${Array(colCount).fill(" --- ").join("|")}|\n`);
	for (let i = 1; i < allRows.length; i++) {
		out.push(pad(allRows[i]) + "\n");
	}
	out.push("\n");
}

/** 收集某元素的直接子元素中，本地名匹配 name 的元素 */
function childrenByName(el: Element, name: string): Element[] {
	return Array.from(el.children).filter((c) => c.localName === name);
}

/** 折叠连续空行至最多一个，去首尾空行，并确保文本内换行后的空格被清理 */
function normalizeMarkdown(raw: string): string {
	return raw
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 构建图片收集器：生成唯一文件名 */
export function createImageCollector(): ImageCollector {
	const seen = new Map<string, string>();
	const placeholders: ImagePlaceholder[] = [];

	const baseName = (src: string): string => {
		const name = decodeURIComponent(src.split(/[?#]/)[0]).split("/").pop() ?? "";
		return name || `img_${placeholders.length}`;
	};

	return {
		placeholders,
		resolve(src: string): string {
			const name = baseName(src);
			// 同源图片复用同一文件名
			if (seen.has(src)) {
				return `images/${seen.get(src)}`;
			}
			let filename = name;
			if (!/\.[a-z0-9]+$/i.test(filename)) {
				filename = `${name}.png`;
			}
			// 避免重名冲突
			let unique = filename;
			let n = 1;
			while (seen.has(unique)) {
				unique = `${n}_${filename}`;
				n++;
			}
			seen.set(src, unique);
			placeholders.push({ src, filename: unique });
			return `images/${unique}`;
		},
	};
}
