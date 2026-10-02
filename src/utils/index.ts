import { normalizePath, type Vault } from "obsidian";

/** 讲解/文件名相关常量 */
export const MAX_WORD_LEN = 100;
export const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;

/** 清洗为合法文件名：去掉 Windows 非法字符，空白转下划线，限长 */
export function sanitizeFileName(word: string): string {
	return word
		.replace(FORBIDDEN_NAME_CHARS, "")
		.replace(/\s+/g, "_")
		.trim()
		.slice(0, MAX_WORD_LEN) || "untitled";
}

/** 由单词 + 输出目录拼出 vault 相对路径 */
export function resolveTargetPath(word: string, outputDir: string): string {
	const fileName = `${sanitizeFileName(word)}.md`;
	const dir = (outputDir ?? "").trim();
	if (!dir) {
		return normalizePath(fileName);
	}
	return normalizePath(`${dir}/${fileName}`);
}

/** 确保 vault 内目录存在（并发创建时忽略竞态） */
export async function ensureFolder(
	vault: Vault,
	folder: string,
): Promise<void> {
	if (!folder) {
		return;
	}
	const normalized = normalizePath(folder);
	const existing = vault.getAbstractFileByPath(normalized);
	if (existing) {
		return;
	}
	try {
		await vault.createFolder(normalized);
	} catch (e) {
		// 可能是并发创建，忽略
		const again = vault.getAbstractFileByPath(normalized);
		if (!again) {
			throw e;
		}
	}
}

/** 读取当前选区的视口位置；无有效选区时返回 null */
export function getSelectionRect(): DOMRect | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) {
		return null;
	}
	const rect = sel.getRangeAt(0).getBoundingClientRect();
	if (!rect || (rect.width === 0 && rect.height === 0)) {
		return null;
	}
	return rect;
}
