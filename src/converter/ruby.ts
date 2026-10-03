/**
 * 移除 HTML 中的汉字假名注音（<ruby>/<rt>/<rp>）。
 *
 * 参考项目 epub-ruby-remover 用正则 `<rt>.*?</rt>` + 去 `<ruby>` 标签实现；
 * 这里用 DOM 操作等价值得替换更稳健（兼容嵌套、属性、自闭合、大小写）。
 * 效果：`<ruby>漢字<rt>かんじ</rt></ruby>` → `漢字`（保留基底汉字，丢弃注音）。
 */
export function stripRuby(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	if (doc.querySelector("parsererror")) {
		// 解析失败则原样返回，避免破坏内容
		return html;
	}

	const rubies = Array.from(doc.querySelectorAll("ruby"));
	for (const ruby of rubies) {
		// 移除所有注音/注音括号元素，保留基底文本节点
		for (const rt of Array.from(ruby.querySelectorAll("rt, rp"))) {
			rt.remove();
		}
		// 把 ruby 元素替换为其剩余子节点（解除包裹）
		const parent = ruby.parentNode;
		if (!parent) {
			continue;
		}
		while (ruby.firstChild) {
			parent.insertBefore(ruby.firstChild, ruby);
		}
		ruby.remove();
	}

	return doc.body.innerHTML;
}
