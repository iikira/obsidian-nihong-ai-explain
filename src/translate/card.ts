import { positionCard } from "../popupUtils";

const CARD_CLASS = "nihong-ai-translate-card";

type State = "loading" | "result" | "error";

/**
 * 在选区附近显示译文浮动卡片。
 * 调用方传入选区 rect（视口坐标），show*() 系列方法负责渲染并定位。
 */
export class TranslateCard {
	private el: HTMLDivElement | null = null;
	private scrollHandler = (): void => this.hide();

	/** 在选区附近显示 loading 状态 */
	showLoading(rect: DOMRect): void {
		this.ensureEl();
		this.render("loading", "正在翻译…");
		this.position(rect);
		this.attachHideListeners();
	}

	/** 显示译文 */
	showResult(text: string, rect: DOMRect): void {
		this.ensureEl();
		this.render("result", text);
		this.position(rect);
	}

	/** 显示错误 */
	showError(message: string, rect: DOMRect): void {
		this.ensureEl();
		this.render("error", message);
		this.position(rect);
	}

	hide(): void {
		if (this.el) {
			this.el.setCssStyles({ display: "none" });
			this.el.remove();
			this.el = null;
		}
		document.removeEventListener("scroll", this.scrollHandler, true);
	}

	private ensureEl(): void {
		if (this.el) {
			return;
		}
		const div = document.body.createDiv({ cls: CARD_CLASS });
		div.setCssStyles({ display: "none" });
		const close = div.createEl("button", { cls: "nihong-ai-translate-close" });
		close.textContent = "×";
		close.title = "关闭";
		close.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.hide();
		});
		div.createDiv({ cls: "nihong-ai-translate-body" });
		// 点击卡片外部关闭
		const onDocClick = (e: MouseEvent): void => {
			if (e.target instanceof Element && e.target.closest(`.${CARD_CLASS}`)) {
				return;
			}
			this.hide();
			document.removeEventListener("mousedown", onDocClick);
		};
		document.addEventListener("mousedown", onDocClick);
		this.el = div;
	}

	private render(state: State, content: string): void {
		if (!this.el) {
			return;
		}
		const body = this.el.querySelector(".nihong-ai-translate-body");
		if (!body) {
			return;
		}
		body.empty();
		this.el.dataset.state = state;
		if (state === "loading") {
			body.createDiv({ cls: "nihong-ai-spinner" });
			const label = body.createSpan();
			label.textContent = content;
		} else {
			const pre = body.createDiv({ cls: "nihong-ai-translate-text" });
			pre.textContent = content;
		}
	}

	private position(rect: DOMRect): void {
		if (!this.el) {
			return;
		}
		const { top, left } = positionCard(this.el, rect);
		this.el.setCssStyles({ top: `${top}px`, left: `${left}px` });
	}

	private attachHideListeners(): void {
		document.addEventListener("scroll", this.scrollHandler, true);
	}
}
