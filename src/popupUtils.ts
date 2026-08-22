const MARGIN = 4;
const GAP = 8;

/**
 * 计算浮动卡片在选区附近的位置（视口坐标，用于 position: absolute 的卡片）。
 * 默认放选区下方，下方溢出则放上方，仍溢出则贴底/贴顶。
 */
export function positionCard(
	cardEl: HTMLElement,
	rect: DOMRect
): { top: number; left: number } {
	// 先显示以测量尺寸
	cardEl.style.display = "block";
	const cardRect = cardEl.getBoundingClientRect();
	const cardW = cardRect.width;
	const cardH = cardRect.height;

	let top = rect.bottom + GAP + window.scrollY;
	let left = rect.left + window.scrollX + (rect.width - cardW) / 2;
	if (left < MARGIN + window.scrollX) {
		left = MARGIN + window.scrollX;
	}
	const maxLeft = window.innerWidth - cardW - MARGIN + window.scrollX;
	if (left > maxLeft) {
		left = maxLeft;
	}
	// 下方溢出则放上方
	const viewportBottom = window.innerHeight + window.scrollY;
	if (top + cardH > viewportBottom - MARGIN) {
		const aboveTop = rect.top - GAP - cardH + window.scrollY;
		if (aboveTop > MARGIN + window.scrollY) {
			top = aboveTop;
		} else {
			// 都放不下，贴近底部
			top = viewportBottom - cardH - MARGIN;
		}
	}
	return { top, left };
}

/** 在视口中央生成一个 fallback rect（用于选区已失效时） */
export function centerRect(): DOMRect {
	return new DOMRect(
		window.innerWidth / 2 - 150,
		window.innerHeight / 2 - 60,
		300,
		40
	);
}
