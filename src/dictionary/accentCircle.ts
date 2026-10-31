/**
 * 声调核位置 → 圆圈数字标记（⓪①②…）的共享渲染。
 *
 * 从 src/explain/renderTerm.ts 与 src/dictionary/popup.ts 两处相同实现抽出，
 * 保证 AI 讲解提示词与词典弹窗的声调标记一致（同一函数，不会漂移）。
 */

/** 把声调核位置数字转成圆圈数字标记：0 → ⓪（平板型），1-20 → ①-⑳，>20 退化为 (N) */
export function toAccentCircle(position: number): string {
	if (position === 0) {
		return "⓪";
	}
	if (position >= 1 && position <= 20) {
		// ①=U+2460，依次递增到 ⑳=U+2473
		return String.fromCodePoint(0x2460 + (position - 1));
	}
	// 超过 20 的少见情况：用括号数字兜底
	return `(${position})`;
}
