/**
 * 比较两个词典 revision 字符串：返回 a<b=-1，a==b=0，a>b=1。
 *
 * Jitendex / Yomitan 的 revision 多为 ISO 日期（如 "2024-03-15"），
 * 按数字段依次比较更稳健；退而按字符串字典序比较（ISO 日期字典序与数值序一致）。
 *
 * 纯函数，无副作用，便于单测。
 */
export function compareRevisions(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	const na = a.replace(/\D+/g, " ").trim().split(/\s+/).filter(Boolean);
	const nb = b.replace(/\D+/g, " ").trim().split(/\s+/).filter(Boolean);
	const len = Math.min(na.length, nb.length);
	for (let i = 0; i < len; i++) {
		const diff = Number(na[i]) - Number(nb[i]);
		if (diff !== 0) {
			return diff < 0 ? -1 : 1;
		}
	}
	// 数字段全等但长度不同：段多者为新（如 1.2 vs 1.2.1）
	if (na.length !== nb.length) {
		return na.length < nb.length ? -1 : 1;
	}
	// 退化为字典序
	return a < b ? -1 : a > b ? 1 : 0;
}
