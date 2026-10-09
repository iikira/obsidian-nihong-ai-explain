/**
 * 最小 localStorage + window.setTimeout mock，供 LRUTranslateCache 测试。
 * 用全局 Map 承载 localStorage；setTimeout 用 Node 的 setTimeout 并记录 timer。
 * 安装：调用 installMockStorage()；卸载：restoreMockStorage()。
 */
const store = new Map<string, string>();
let savedLocalStorage: unknown;
let savedWindow: unknown;

export function installMockStorage(): void {
	savedLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
	savedWindow = (globalThis as { window?: unknown }).window;
	const mockLocalStorage = {
		getItem(k: string): string | null {
			return store.has(k) ? store.get(k)! : null;
		},
		setItem(k: string, v: string): void {
			store.set(k, String(v));
		},
		removeItem(k: string): void {
			store.delete(k);
		},
		clear(): void {
			store.clear();
		},
	};
	(globalThis as { localStorage: unknown }).localStorage = mockLocalStorage;
	// window.setTimeout / window.clearTimeout：指向 Node 的对应函数
	(globalThis as { window: Record<string, unknown> }).window = {
		setTimeout: (...args: unknown[]) =>
			(setTimeout as (...a: unknown[]) => unknown)(...args),
		clearTimeout: (...args: unknown[]) =>
			(clearTimeout as (...a: unknown[]) => unknown)(...args),
	};
}

export function restoreMockStorage(): void {
	(globalThis as { localStorage?: unknown }).localStorage = savedLocalStorage;
	(globalThis as { window?: unknown }).window = savedWindow;
}

export function getStore(): Map<string, string> {
	return store;
}

export function clearStore(): void {
	store.clear();
}
