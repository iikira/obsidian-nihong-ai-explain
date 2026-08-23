import { positionCard } from "../popupUtils";
import { getFuriganaSegments } from "./furigana";
import type { LookupResult, ProcessedTag, ContentNode } from "./types";

const CARD_CLASS = "nihong-ai-dict-popup";
type State = "loading" | "result" | "error" | "empty";

export class DictionaryPopup {
	private el: HTMLDivElement | null = null;
	private scrollHandler = (e: Event): void => {
		// 卡片内部滚动条滚动不触发 hide
		if (e.target instanceof Element && e.target.closest(`.${CARD_CLASS}`)) {
			return;
		}
		this.hide();
	};
	private externalClickHandler: ((e: MouseEvent) => void) | null = null;
	private copyHandler = (e: ClipboardEvent): void => {
		this.sanitizeCopy(e);
	};
	private clickHandler = (e: MouseEvent): void => {
		this.handleLinkClick(e);
	};

	constructor(
		private getTag: (name: string) => ProcessedTag | undefined,
		private onNavigate?: (query: string) => void,
		private getFontSize?: () => number,
	) {}

	showLoading(rect: DOMRect): void {
		this.ensureEl();
		this.render("loading", "正在查词典…");
		this.position(rect);
		this.attachHideListeners();
	}

	showResult(terms: LookupResult[], rect: DOMRect): void {
		this.ensureEl();
		if (terms.length === 0) {
			this.render("empty", "未查到该词");
		} else {
			this.renderTerms(terms);
		}
		this.position(rect);
		this.attachHideListeners();
	}

	showError(message: string, rect: DOMRect): void {
		this.ensureEl();
		this.render("error", message);
		this.position(rect);
		this.attachHideListeners();
	}

	/** 获取卡片当前 bounding rect，供交叉引用重查复用 */
	getRect(): DOMRect | null {
		if (!this.el || this.el.style.display === "none") {
			return null;
		}
		return this.el.getBoundingClientRect();
	}

	hide(): void {
		if (this.el) {
			this.el.removeEventListener("copy", this.copyHandler);
			this.el.removeEventListener("click", this.clickHandler);
			this.el.remove();
			this.el = null;
		}
		document.removeEventListener("scroll", this.scrollHandler, true);
		if (this.externalClickHandler) {
			document.removeEventListener("mousedown", this.externalClickHandler);
			this.externalClickHandler = null;
		}
	}

	private ensureEl(): void {
		if (this.el) {
			return;
		}
		const div = document.createElement("div");
		div.className = CARD_CLASS;
		const fs = this.getFontSize?.() ?? 0;
		if (fs > 0) {
			div.style.setProperty("--nihong-ai-dict-fs", `${fs}px`);
		}
		div.style.display = "none";
		const close = document.createElement("button");
		close.className = "nihong-ai-dict-close";
		close.innerHTML = "&times;";
		close.title = "关闭";
		close.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.hide();
		});
		div.appendChild(close);
		const body = document.createElement("div");
		body.className = "nihong-ai-dict-body";
		div.appendChild(body);
		document.body.appendChild(div);
		this.el = div;
	}

	private render(state: State, content: string): void {
		if (!this.el) {
			return;
		}
		const body = this.el.querySelector(".nihong-ai-dict-body") as HTMLElement | null;
		if (!body) {
			return;
		}
		body.empty();
		this.el.dataset.state = state;
		if (state === "loading") {
			const spinner = document.createElement("div");
			spinner.className = "nihong-ai-spinner";
			const label = document.createElement("span");
			label.textContent = content;
			body.appendChild(spinner);
			body.appendChild(label);
		} else {
			const msg = document.createElement("div");
			msg.className = "nihong-ai-dict-message";
			msg.textContent = content;
			body.appendChild(msg);
		}
	}

	private renderTerms(terms: LookupResult[]): void {
		if (!this.el) {
			return;
		}
		const body = this.el.querySelector(".nihong-ai-dict-body") as HTMLElement | null;
		if (!body) {
			return;
		}
		body.empty();
		this.el!.dataset.state = "result";

		// 排序：expression === reading 的（纯假名词）排前，再按 score 降序
		const sorted = [...terms].sort((a, b) => {
			const aIsKana = a.expression === a.reading ? 0 : 1;
			const bIsKana = b.expression === b.reading ? 0 : 1;
			if (aIsKana !== bIsKana) {
				return aIsKana - bIsKana;
			}
			return b.score - a.score;
		});

		// 按 expression|reading 分组
		const groups = new Map<string, LookupResult[]>();
		for (const t of sorted) {
			const key = `${t.expression}|${t.reading}`;
			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(t);
		}

		for (const [key, groupTerms] of groups) {
			const [expression, reading] = key.split("|");
			const entryDiv = document.createElement("div");
			entryDiv.className = "nihong-ai-dict-entry";

			// 振假名 header
			const header = document.createElement("div");
			header.className = "nihong-ai-dict-header";
			if (expression !== reading) {
				const segments = getFuriganaSegments(expression, reading);
				const ruby = document.createElement("ruby");
				ruby.className = "nihong-ai-dict-furigana";
				for (const seg of segments) {
					const base = document.createElement("span");
					base.textContent = seg.text;
					ruby.appendChild(base);
					if (seg.reading) {
						const rt = document.createElement("rt");
						rt.textContent = seg.reading;
						ruby.appendChild(rt);
					}
				}
				header.appendChild(ruby);
			} else {
				const span = document.createElement("span");
				span.className = "nihong-ai-dict-furigana";
				span.textContent = expression;
				header.appendChild(span);
			}

			// 变形原因
			const first = groupTerms[0];
			if (first.deinflectionReasons && first.deinflectionReasons.length > 0) {
				const reason = document.createElement("span");
				reason.className = "nihong-ai-dict-reason";
				reason.textContent = ` ← ${first.deinflectionReasons.join(" ← ")}`;
				header.appendChild(reason);
			}
			entryDiv.appendChild(header);

			// 释义列表
			const ol = document.createElement("ol");
			ol.className = "nihong-ai-dict-senses";
			for (const term of groupTerms) {
				const li = document.createElement("li");
				li.className = "nihong-ai-dict-sense";

				// 词性标签
				if (term.tags.length > 0) {
					const tagSpan = document.createElement("span");
					tagSpan.className = "nihong-ai-dict-tags";
					for (const t of term.tags) {
						if (!t) {
							continue;
						}
						const tag = document.createElement("span");
						tag.className = "nihong-ai-dict-tag";
						tag.textContent = t;
						const tagDef = this.getTag(t);
						if (tagDef) {
							tag.title = tagDef.notes || tagDef.short || "";
						}
						tagSpan.appendChild(tag);
					}
					li.appendChild(tagSpan);
				}

				// 释义内容
				const glossDiv = document.createElement("div");
				glossDiv.className = "nihong-ai-dict-glossary";
				for (const g of term.glossary) {
					this.renderContentNode(glossDiv, g as ContentNode);
				}
				li.appendChild(glossDiv);
				ol.appendChild(li);
			}
			entryDiv.appendChild(ol);
			body.appendChild(entryDiv);
		}
	}

	private renderContentNode(container: HTMLElement, node: ContentNode): void {
		if (node == null) {
			return;
		}
		if (typeof node === "string") {
			const span = document.createElement("span");
			span.textContent = node;
			container.appendChild(span);
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				this.renderContentNode(container, child as ContentNode);
			}
			return;
		}
		if (typeof node !== "object") {
			container.append(String(node));
			return;
		}
		if ("tag" in node) {
			const content = node;
			const el = document.createElement(content.tag);
			if (content.data) {
				for (const [k, v] of Object.entries(content.data)) {
					if (k === "class") {
						el.className = `nihong-ai-dict-${v}`;
					} else {
						el.setAttribute(k, v);
					}
				}
			}
			if (content.href) {
				el.setAttribute("href", content.href);
			}
			if (content.title) {
				el.title = content.title;
			}
			if (content.lang) {
				el.lang = content.lang;
			}
			if (content.content !== undefined) {
				this.renderContentNode(el, content.content as ContentNode);
			}
			container.appendChild(el);
			return;
		}
		if (!("type" in node)) {
			return;
		}
		const t = node;
		switch (t.type) {
			case "text": {
				const span = document.createElement("span");
				span.textContent = t.text;
				container.appendChild(span);
				break;
			}
			case "structured":
			case "structured-content": {
				this.renderContentNode(container, t.content as ContentNode);
				break;
			}
			case "link": {
				const a = document.createElement("a");
				if (t.href) {
					a.setAttribute("href", t.href);
				}
				if (t.text) {
					a.textContent = t.text;
				}
				if (t.content !== undefined) {
					this.renderContentNode(a, t.content as ContentNode);
				}
				container.appendChild(a);
				break;
			}
			case "image": {
				const img = document.createElement("img");
				img.alt = t.title ?? "";
				img.title = t.title ?? "";
				if (t.width) {
					img.width = t.width;
				}
				if (t.height) {
					img.height = t.height;
				}
				img.loading = "lazy";
				container.appendChild(img);
				break;
			}
			case "audio":
				break;
			case "quote": {
				const q = document.createElement("blockquote");
				q.className = "nihong-ai-dict-quote";
				if (t.content !== undefined) {
					this.renderContentNode(q, t.content as ContentNode);
				}
				container.appendChild(q);
				break;
			}
			case "footnote": {
				const fn = document.createElement("aside");
				fn.className = "nihong-ai-dict-footnote";
				if (t.reference) {
					const ref = document.createElement("span");
					ref.className = "nihong-ai-dict-footnote-ref";
					ref.textContent = t.reference;
					fn.appendChild(ref);
				}
				if (t.content !== undefined) {
					this.renderContentNode(fn, t.content as ContentNode);
				}
				container.appendChild(fn);
				break;
			}
			case "deinflection": {
				if (t.variant) {
					const span = document.createElement("span");
					span.className = "nihong-ai-dict-deinflection";
					span.textContent = t.variant;
					container.appendChild(span);
				}
				break;
			}
			case "example": {
				if (t.content !== undefined) {
					this.renderContentNode(container, t.content as ContentNode);
				}
				break;
			}
			default:
				break;
		}
	}

	private position(rect: DOMRect): void {
		if (!this.el) {
			return;
		}
		const { top, left } = positionCard(this.el, rect);
		this.el.style.top = `${top}px`;
		this.el.style.left = `${left}px`;
	}

	private attachHideListeners(): void {
		// 先卸载旧监听，避免 lookupInPopup 重查时累积重复绑定
		document.removeEventListener("scroll", this.scrollHandler, true);
		if (this.externalClickHandler) {
			document.removeEventListener("mousedown", this.externalClickHandler);
		}
		if (this.el) {
			this.el.removeEventListener("copy", this.copyHandler);
			this.el.removeEventListener("click", this.clickHandler);
		}
		document.addEventListener("scroll", this.scrollHandler, true);
		this.externalClickHandler = (e: MouseEvent): void => {
			if (e.target instanceof Element && e.target.closest(`.${CARD_CLASS}`)) {
				return;
			}
			this.hide();
		};
		document.addEventListener("mousedown", this.externalClickHandler);
		if (this.el) {
			this.el.addEventListener("copy", this.copyHandler);
			this.el.addEventListener("click", this.clickHandler);
		}
	}

	/** 拦截交叉引用/外链点击，防止 Obsidian 把 ?query= 当 vault 文件路径解析导致崩溃 */
	private handleLinkClick(e: MouseEvent): void {
		const target = e.target;
		if (!(target instanceof Element)) {
			return;
		}
		const anchor = target.closest("a");
		if (!anchor) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		const href = anchor.getAttribute("href") ?? "";
		if (href.startsWith("?")) {
			// Yomitan 内部交叉引用：?query=WORD&wildcards=off&...
			const params = new URLSearchParams(href.slice(1));
			const query = params.get("query");
			if (query && this.onNavigate) {
				this.onNavigate(decodeURIComponent(query));
			}
			return;
		}
		if (/^https?:\/\//i.test(href)) {
			window.open(href, "_blank", "noopener,noreferrer");
			return;
		}
		// 其他不识别的链接不导航
	}

	/** 复制时剥离振假名 <rt>，只留汉字本体 */
	private sanitizeCopy(e: ClipboardEvent): void {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return;
		}
		const range = selection.getRangeAt(0);
		// 只处理选区与本卡片有交集的情况
		if (!this.el || !this.el.contains(range.commonAncestorContainer) && !range.intersectsNode(this.el)) {
			return;
		}
		const fragment = range.cloneContents();
		// 移除所有 <rt>（振假名注音）——保留 <ruby> 的 base text
		fragment.querySelectorAll("rt").forEach((rt) => rt.remove());
		const text = this.fragmentToText(fragment);
		const plain = text.replace(/\n{3,}/g, "\n\n").trim();
		if (e.clipboardData) {
			e.clipboardData.setData("text/plain", plain);
			e.preventDefault();
		}
	}

	private fragmentToText(fragment: DocumentFragment): string {
		// 用 innerText 取视觉换行（尊重 block 元素），fallback 到 textContent
		const div = document.createElement("div");
		div.appendChild(fragment);
		return div.innerText || div.textContent || "";
	}
}
