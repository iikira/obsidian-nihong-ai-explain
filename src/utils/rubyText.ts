/**
 * 清理选中文本中的振假名（<ruby>/<rt>/<rp>）标签，只留基底汉字。
 *
 * 处理编辑器源码选中场景：选中文本含字面 <ruby>漢字<rt>かんじ</rt></ruby> 标签字符串。
 * （Reading 视图选中场景的 ruby 分离在选区读取点用 selectionToCleanText 处理。）
 *
 * 效果：`<ruby>漢字<rt>かんじ</rt></ruby>の読み` → `漢字の読み`
 */
export function cleanSelectionText(text: string): string {
	return text
		// 去 <rt>...</rt> / <rp>...</rp> 注音（含属性、大小写、跨行）
		.replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
		.replace(/<rp\b[^>]*>[\s\S]*?<\/rp>/gi, "")
		// 解包 <ruby>...</ruby>，保留内部基底（rt/rp 已清）
		.replace(/<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi, "$1")
		// 兜底：残留的自闭合/未配对 <ruby>/<rt>/<rp> 起止标签
		.replace(/<\/?(?:ruby|rt|rp)\b[^>]*>/gi, "")
		// 清理标签移除后可能残留的多余空白（连续空格/制表符压缩）
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * 移除 DocumentFragment 内所有 <rt>/<rp> 元素，返回剩余纯文本（基底汉字）。
 *
 * 直接在 fragment DOM 上移除，不依赖 <ruby> 父元素——Reading 视图选中 ruby **内部**
 * 文字时，cloneContents() 返回的 fragment 不含 <ruby> 元素本身（ruby 是 commonAncestor
 * 在选区外），只有孤立的 <rt> 子节点，故不能像 stripRuby 那样先找 <ruby> 再清内部 <rt>。
 */
export function stripRtFromFragment(fragment: DocumentFragment): string {
	for (const el of Array.from(fragment.querySelectorAll("rt, rp"))) {
		el.remove();
	}
	return collectText(fragment).trim();
}

/** 递归收集节点的文本内容（兼容部分 DOM 实现对 DocumentFragment.textContent 返回 null 的情况） */
function collectText(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent ?? "";
	}
	let out = "";
	for (const child of Array.from(node.childNodes)) {
		out += collectText(child);
	}
	return out;
}

/**
 * 从 Selection 提取干净文本（去掉振假名注音）。
 *
 * Reading 视图选中时，浏览器 toString() 会把 ruby 注音混入基底（如 漢字かんじ），
 * 字符串层无法分离；这里取选区 range 的 cloneContents() fragment，移除所有 <rt>/<rp>
 * 元素（无论是否有 <ruby> 父），再取 textContent 得到基底文本。
 * 退化（无 range / fragment 为空 / 异常）时回退 sel.toString() 再过 cleanSelectionText
 * （处理字面标签场景）。
 */
export function selectionToCleanText(sel: Selection): string {
	const plain = sel.toString();
	try {
		if (sel.rangeCount === 0) {
			return cleanSelectionText(plain);
		}
		const fragment = sel.getRangeAt(0).cloneContents();
		const text = stripRtFromFragment(fragment);
		return text || cleanSelectionText(plain);
	} catch {
		return cleanSelectionText(plain);
	}
}
