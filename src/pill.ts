import { setIcon } from "obsidian";

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
const SELECTION_DEBOUNCE_MS = 300;

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
	handler: (text: string) => Promise<void> | void;
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
	private pendingSelectionDebounce: number | null = null;
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
		this.clearSelectionDebounce();
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
		this.scheduleShowAfterSelection();
	}

	/**
	 * 选区确定后启动 fallback 计时：等 FALLBACK_DELAY_MS 看 lexis 是否弹 pill，
	 * 未弹则自己 fallback。mouseup（桌面）与 selectionchange 去抖（移动）共用此逻辑。
	 */
	private scheduleShowAfterSelection(): void {
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
			this.clearSelectionDebounce();
			this.hideFallback();
			this.currentSelection = "";
			return;
		}
		// 移动端选区确定后 mouseup 不一定触发，用 selectionchange 兜底。
		// 去抖 SELECTION_DEBOUNCE_MS 避免拖选过程中频繁触发，且让选区稳定。
		this.clearSelectionDebounce();
		this.pendingSelectionDebounce = window.setTimeout(() => {
			this.pendingSelectionDebounce = null;
			// 去抖结束后再次校验选区仍有效（用户可能中途清空了）
			const cur = this.readSelection();
			if (cur == null) {
				this.hideFallback();
				this.currentSelection = "";
				return;
			}
			this.currentSelection = cur;
			// 复用 mouseup 的"等 lexis / fallback"逻辑
			this.scheduleShowAfterSelection();
		}, SELECTION_DEBOUNCE_MS);
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
			if (action.icon) {
				setIcon(btn, action.icon);
			} else {
				btn.textContent = action.label;
			}
			btn.title = action.label;
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				if (btn.getAttribute("data-busy") === "true") {
					return;
				}
				const text = this.currentSelection || this.readSelection() || "";
				if (!text) {
					return;
				}
				// 禁用整个 pill（含 lexis 自家按钮），防止重复调用
				this.markPillBusy(lePill, true);
				Promise.resolve(action.handler(text)).finally(() => {
					this.markPillBusy(lePill, false);
				});
			});
			lePill.appendChild(btn);
		}

		// 注入新按钮后 pill 变宽，lexis 用旧宽度算的 left 已失效，重新定位防出屏
		this.repositionPill(lePill);
	}

	/** 重新定位 pill，确保不出视口；选区底部空间不足时弹到选区上方 */
	private repositionPill(pill: Element): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			return;
		}
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.width === 0 && rect.height === 0)) {
			return;
		}
		const el = pill as HTMLElement;
		// 强制布局以拿真实尺寸
		const pw = el.offsetWidth;
		const ph = el.offsetHeight;
		if (pw === 0 || ph === 0) {
			// 尚未布局，下一帧再试
			requestAnimationFrame(() => this.repositionPill(pill));
			return;
		}
		const margin = 6;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// 水平：默认贴选区左边缘，右溢出则左移，仍超宽则贴左 6px
		let left = Math.max(margin, Math.min(rect.left, vw - pw - margin));
		if (rect.left + pw > vw - margin) {
			// 右边放不下：尝试向左对齐选区右边缘
			left = Math.max(margin, rect.right - pw);
		}
		// 垂直：默认选区下方，下方不够则上方
		let top = rect.bottom + margin;
		if (top + ph > vh - margin) {
			const above = rect.top - ph - margin;
			if (above >= margin) {
				top = above;
			} else {
				// 上下都紧：贴底
				top = Math.max(margin, vh - ph - margin);
			}
		}
		el.style.top = `${top}px`;
		el.style.left = `${left}px`;
	}

	private markBusy(el: HTMLElement, busy: boolean): void {
		if (busy) {
			el.setAttribute("data-busy", "true");
			el.style.opacity = "0.5";
			el.style.pointerEvents = "none";
		} else {
			el.removeAttribute("data-busy");
			el.style.opacity = "";
			el.style.pointerEvents = "";
		}
	}

	/** 禁用 pill 内所有按钮（含 lexis 自家按钮与我们注入的按钮） */
	private markPillBusy(pill: Element, busy: boolean): void {
		const btns = pill.querySelectorAll(".lexis-sel-pill-btn, .nihong-ai-pill-btn");
		btns.forEach((el) => {
			if (el instanceof HTMLElement) {
				this.markBusy(el, busy);
			}
		});
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
			if (action.icon) {
				setIcon(btn, action.icon);
			} else {
				btn.textContent = action.label;
			}
			btn.title = action.label;
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				if (btn.getAttribute("data-busy") === "true") {
					return;
				}
				const text = this.currentSelection;
				if (!text) {
					return;
				}
				// 禁用整个 pill 所有按钮，防止重复调用
				this.markPillBusy(div, true);
				Promise.resolve(action.handler(text)).finally(() => {
					this.markPillBusy(div, false);
					this.hideFallback();
					this.currentSelection = "";
				});
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

	private clearSelectionDebounce(): void {
		if (this.pendingSelectionDebounce != null) {
			clearTimeout(this.pendingSelectionDebounce);
			this.pendingSelectionDebounce = null;
		}
	}
}
