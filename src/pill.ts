const PILL_CLASS = "nihong-ai-pill";
const PILL_ID = "nihong-ai-pill";

const SELECTOR_HOSTS = [
	".markdown-source-view",
	".markdown-reading-view",
	".markdown-preview-view",
	".markdown-preview-sizer",
];

function inHost(node: Node | null): boolean {
	if (!node || node.nodeType !== Node.ELEMENT_NODE) {
		return false;
	}
	const el = node as Element;
	return SELECTOR_HOSTS.some((sel) => el.closest(sel) != null);
}

/**
 * 选区下方浮动按钮控制器。
 * 监听全局 mouseup，若选区在 Markdown 视图内且非空，
 * 则在选区下方定位一个浮动按钮，点击后回调 onTrigger(selection 文本)。
 */
export class SelectionPill {
	private el: HTMLDivElement | null = null;
	private currentSelection = "";
	private onTrigger: (text: string) => void;

	constructor(onTrigger: (text: string) => void) {
		this.onTrigger = onTrigger;
		this.onMouseUp = this.onMouseUp.bind(this);
		this.onSelectionChange = this.onSelectionChange.bind(this);
		this.onScroll = this.onScroll.bind(this);
	}

	attach(): void {
		document.addEventListener("mouseup", this.onMouseUp);
		document.addEventListener("selectionchange", this.onSelectionChange);
		document.addEventListener("scroll", this.onScroll, true);
	}

	detach(): void {
		document.removeEventListener("mouseup", this.onMouseUp);
		document.removeEventListener("selectionchange", this.onSelectionChange);
		document.removeEventListener("scroll", this.onScroll, true);
		this.hide();
	}

	private onMouseUp(e: MouseEvent): void {
		if (e.button !== 0) {
			return;
		}
		// 点击在 pill 自身上：交给 pill 的 click 处理
		if (e.target instanceof Element && e.target.closest(`#${PILL_ID}`)) {
			return;
		}
		const sel = this.readSelection();
		if (sel == null) {
			this.hide();
			return;
		}
		this.currentSelection = sel;
		this.show();
	}

	private onSelectionChange(): void {
		const sel = this.readSelection();
		if (sel == null) {
			this.hide();
			this.currentSelection = "";
			return;
		}
		// 不立即移动 pill；等 mouseup 触发显示，避免拖动时闪烁
	}

	private onScroll(): void {
		this.hide();
	}

	private readSelection(): string | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			return null;
		}
		const range = sel.getRangeAt(0);
		if (!range) {
			return null;
		}
		if (!inHost(range.commonAncestorContainer) && !inHost(range.startContainer)) {
			return null;
		}
		const text = sel.toString().trim();
		if (!text) {
			return null;
		}
		return text;
	}

	private show(): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return;
		}
		const range = sel.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			return;
		}
		this.ensureEl();
		const el = this.el!;
		const pillH = 26;
		const pillW = 96;
		const gap = 6;
		let top = rect.bottom + gap + window.scrollY;
		let left = rect.left + window.scrollX + (rect.width - pillW) / 2;
		if (left < 0) {
			left = 0;
		}
		const maxLeft = window.innerWidth - pillW;
		if (left > maxLeft) {
			left = maxLeft;
		}
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
		el.textContent = "AI 讲解";
		el.title = "调用大模型生成讲解笔记";
		el.style.display = "block";
	}

	private ensureEl(): void {
		if (this.el) {
			return;
		}
		const div = document.createElement("div");
		div.id = PILL_ID;
		div.className = PILL_CLASS;
		div.style.display = "none";
		div.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const text = this.currentSelection;
			this.hide();
			this.currentSelection = "";
			if (text) {
				this.onTrigger(text);
			}
		});
		document.body.appendChild(div);
		this.el = div;
	}

	private hide(): void {
		if (this.el) {
			this.el.style.display = "none";
		}
	}
}
