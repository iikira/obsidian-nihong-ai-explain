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
			this.el.style.display = "none";
			this.el.remove();
			this.el = null;
		}
		document.removeEventListener("scroll", this.scrollHandler, true);
	}

	private ensureEl(): void {
		if (this.el) {
			return;
		}
		const div = document.createElement("div");
		div.className = CARD_CLASS;
		div.style.display = "none";
		const close = document.createElement("button");
		close.className = "nihong-ai-translate-close";
		close.innerHTML = "&times;";
		close.title = "关闭";
		close.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.hide();
		});
		div.appendChild(close);
		const body = document.createElement("div");
		body.className = "nihong-ai-translate-body";
		div.appendChild(body);
		// 点击卡片外部关闭
		const onDocClick = (e: MouseEvent): void => {
			if (e.target instanceof Element && e.target.closest(`.${CARD_CLASS}`)) {
				return;
			}
			this.hide();
			document.removeEventListener("mousedown", onDocClick);
		};
		document.addEventListener("mousedown", onDocClick);
		document.body.appendChild(div);
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
			const spinner = document.createElement("div");
			spinner.className = "nihong-ai-spinner";
			const label = document.createElement("span");
			label.textContent = content;
			body.appendChild(spinner);
			body.appendChild(label);
		} else {
			const pre = document.createElement("div");
			pre.className = "nihong-ai-translate-text";
			pre.textContent = content;
			body.appendChild(pre);
		}
	}

	private position(rect: DOMRect): void {
		if (!this.el) {
			return;
		}
		// 先显示以测量尺寸
		this.el.style.display = "block";
		const cardRect = this.el.getBoundingClientRect();
		const gap = 8;
		const margin = 4;
		let top = rect.bottom + gap;
		let left = rect.left + (rect.width - cardRect.width) / 2;
		if (left < margin) {
			left = margin;
		}
		const maxLeft = window.innerWidth - cardRect.width - margin;
		if (left > maxLeft) {
			left = maxLeft;
		}
		// 若下方溢出，尝试放上方
		if (top + cardRect.height > window.innerHeight - margin) {
			const aboveTop = rect.top - gap - cardRect.height;
			if (aboveTop > margin) {
				top = aboveTop;
			} else {
				// 都放不下，贴近底部
				top = window.innerHeight - cardRect.height - margin;
			}
		}
		this.el.style.top = `${top + window.scrollY}px`;
		this.el.style.left = `${left + window.scrollX}px`;
	}

	private attachHideListeners(): void {
		document.addEventListener("scroll", this.scrollHandler, true);
	}
}
