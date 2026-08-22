const FALLBACK_PILL_ID = "nihong-ai-pill";
const LEXIS_PILL_SELECTOR = ".lexis-sel-pill";
const ACTION_ATTR = "data-nihong-action";

const SELECTOR_HOSTS = [
	".markdown-source-view",
	".markdown-reading-view",
	".markdown-preview-view",
	".markdown-preview-sizer",
];

const FALLBACK_DELAY_MS = 150;

function inHost(node: Node | null): boolean {
	if (!node) {
		return false;
	}
	let el: Element | null;
	if (node.nodeType === Node.ELEMENT_NODE) {
		el = node as Element;
	} else if (node.nodeType === Node.TEXT_NODE) {
		el = node.parentElement;
	} else {
		return false;
	}
	if (!el) {
		return false;
	}
	return SELECTOR_HOSTS.some((sel) => el!.closest(sel) != null);
}

export interface PillAction {
	id: string;
	label: string;
	icon?: string;
	handler: (text: string) => void;
}

/**
 * 选区浮动按钮控制器。
 *
 * 优先策略：检测 lexis 的 .lexis-sel-pill 出现后，把自己的按钮
 * 注入进去（与「加入词库」并排显示），避免双 pill 冲突。
 *
 * Fallback：若 lexis 未安装/未启用/选区被 lexis 拒绝（如 >60 字符），
 * 在 mouseup 后 FALLBACK_DELAY_MS 内未观察到 lexis pill，则弹我们自己的
 * .nihong-ai-pill（与 lexis 不冲突，且 z-index 同层）。
 */
export class SelectionPill {
	private actions: PillAction[];
	private fallbackEl: HTMLDivElement | null = null;
	private observer: MutationObserver | null = null;
	private pendingFallbackTimer: number | null = null;
	private currentSelection = "";

	private boundMouseUp: (e: MouseEvent) => void;
	private boundScroll: () => void;
	private boundSelectionChange: () => void;
	private boundKeyDown: (e: KeyboardEvent) => void;

	constructor(actions: PillAction[]) {
		this.actions = actions;
		this.boundMouseUp = this.onMouseUp.bind(this);
		this.boundScroll = this.onScroll.bind(this);
		this.boundSelectionChange = this.onSelectionChange.bind(this);
		this.boundKeyDown = this.onKeyDown.bind(this);
	}

	attach(): void {
		document.addEventListener("mouseup", this.boundMouseUp);
		document.addEventListener("selectionchange", this.boundSelectionChange);
		document.addEventListener("scroll", this.boundScroll, true);
		document.addEventListener("keydown", this.boundKeyDown);

		this.observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				m.addedNodes.forEach((node) => {
					if (node.nodeType !== Node.ELEMENT_NODE) {
						return;
					}
					const el = node as Element;
					if (el.matches?.(LEXIS_PILL_SELECTOR)) {
						this.injectInto(el);
					}
				});
			}
		});
		this.observer.observe(document.body, { childList: true, subtree: false });
	}

	detach(): void {
		document.removeEventListener("mouseup", this.boundMouseUp);
		document.removeEventListener("selectionchange", this.boundSelectionChange);
		document.removeEventListener("scroll", this.boundScroll, true);
		document.removeEventListener("keydown", this.boundKeyDown);
		this.observer?.disconnect();
		this.observer = null;
		this.clearFallbackTimer();
		this.hideFallback();
	}

	private onMouseUp(e: MouseEvent): void {
		if (e.button !== 0) {
			return;
		}
		// 点击在自家 fallback pill 上：交给按钮自身处理
		if (
			e.target instanceof Element &&
			e.target.closest(`#${FALLBACK_PILL_ID}`)
		) {
			return;
		}
		// 点击在 lexis pill 上（含我们注入的按钮）：交给按钮处理
		if (
			e.target instanceof Element &&
			e.target.closest(LEXIS_PILL_SELECTOR)
		) {
			return;
		}
		const sel = this.readSelection();
		if (sel == null) {
			this.hideFallback();
			this.currentSelection = "";
			return;
		}
		this.currentSelection = sel;
		// 等 lexis pill；若超时未出现则 fallback
		this.clearFallbackTimer();
		this.pendingFallbackTimer = window.setTimeout(() => {
			// lexis 未弹 pill（或选区被其规则拒绝），自己弹
			// 再校验一次选区仍有效
			if (this.readSelection() != null) {
				this.showFallback();
			}
		}, FALLBACK_DELAY_MS);
	}

	private onSelectionChange(): void {
		const sel = this.readSelection();
		if (sel == null) {
			this.hideFallback();
			this.currentSelection = "";
		}
	}

	private onScroll(): void {
		this.hideFallback();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			this.hideFallback();
		}
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

	/** 当 lexis pill 出现时，把自己的按钮注入进去（去重） */
	private injectInto(lePill: Element): void {
		// 仅当存在有效选区时才注入（避免 lexis 在我们选区已失效后仍弹 pill）
		const sel = this.readSelection();
		if (sel != null) {
			this.currentSelection = sel;
		}
		// 取消 fallback 计时：lexis 已弹 pill
		this.clearFallbackTimer();
		this.hideFallback();

		for (const action of this.actions) {
			if (lePill.querySelector(`[${ACTION_ATTR}="${action.id}"]`)) {
				continue; // 已注入
			}
			const btn = document.createElement("span");
			btn.className = "lexis-sel-pill-btn";
			btn.setAttribute(ACTION_ATTR, action.id);
			btn.textContent = action.label;
			btn.title = action.label;
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const text = this.currentSelection || this.readSelection() || "";
				if (text) {
					action.handler(text);
				}
			});
			lePill.appendChild(btn);
		}
	}

	// ====== Fallback pill（lexis 未弹时） ======

	private showFallback(): void {
		// 双保险：若 lexis 已弹 pill，不弹自家 fallback，避免重复
		if (document.querySelector(LEXIS_PILL_SELECTOR)) {
			return;
		}
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return;
		}
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			return;
		}
		this.ensureFallbackEl();
		const el = this.fallbackEl!;
		const gap = 6;
		const pillW = 28 + this.actions.length * 70;
		let top = rect.bottom + gap + window.scrollY;
		let left = rect.left + window.scrollX + (rect.width - pillW) / 2;
		if (left < 4) {
			left = 4;
		}
		const maxLeft = window.innerWidth - pillW - 4;
		if (left > maxLeft) {
			left = maxLeft;
		}
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
		el.style.display = "inline-flex";
	}

	private ensureFallbackEl(): void {
		if (this.fallbackEl) {
			return;
		}
		const div = document.createElement("div");
		div.id = FALLBACK_PILL_ID;
		div.className = "nihong-ai-pill";
		div.style.display = "none";
		// 防止点击 pill 时选区收起
		div.addEventListener("mousedown", (ev) => ev.preventDefault());
		for (const action of this.actions) {
			const btn = document.createElement("button");
			btn.className = "nihong-ai-pill-btn";
			btn.textContent = action.label;
			btn.title = action.label;
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const text = this.currentSelection;
				this.hideFallback();
				this.currentSelection = "";
				if (text) {
					action.handler(text);
				}
			});
			div.appendChild(btn);
		}
		document.body.appendChild(div);
		this.fallbackEl = div;
	}

	private hideFallback(): void {
		if (this.fallbackEl) {
			this.fallbackEl.style.display = "none";
		}
	}

	private clearFallbackTimer(): void {
		if (this.pendingFallbackTimer != null) {
			clearTimeout(this.pendingFallbackTimer);
			this.pendingFallbackTimer = null;
		}
	}
}
