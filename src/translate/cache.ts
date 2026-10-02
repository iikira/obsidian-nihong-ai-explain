const STORAGE_KEY = "nihong-ai-translate-cache";
const CAPACITY = 1024;
const FLUSH_DELAY_MS = 500;

/**
 * LRU 翻译缓存。内存用 Map（保持插入顺序，访问时 delete+set 提升为最新），
 * 持久化到 localStorage（防抖写入，避免高频请求时频繁写）。
 */
export class LRUTranslateCache {
	private map: Map<string, string> = new Map();
	private flushTimer: number | null = null;

	load(): void {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (!raw) {
				return;
			}
			const entries = JSON.parse(raw) as [string, string][];
			if (!Array.isArray(entries)) {
				return;
			}
			for (const [k, v] of entries) {
				if (typeof k === "string" && typeof v === "string") {
					this.map.set(k, v);
				}
			}
		} catch (e) {
			console.warn("[nihong-ai] 翻译缓存加载失败:", e);
		}
	}

	get(key: string): string | undefined {
		if (!this.map.has(key)) {
			return undefined;
		}
		// LRU：删除再 set，提升为最新
		const v = this.map.get(key)!;
		this.map.delete(key);
		this.map.set(key, v);
		this.scheduleFlush();
		return v;
	}

	set(key: string, value: string): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		}
		this.map.set(key, value);
		// 淘汰最旧
		while (this.map.size > CAPACITY) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.map.delete(oldest);
		}
		this.scheduleFlush();
	}

	clear(): void {
		this.map.clear();
		if (this.flushTimer != null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			console.warn("[nihong-ai] 清空 localStorage 失败:", e);
		}
	}

	size(): number {
		return this.map.size;
	}

	/** 立即写入 localStorage（卸载时调用） */
	flush(): void {
		if (this.flushTimer != null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.writeNow();
	}

	private scheduleFlush(): void {
		if (this.flushTimer != null) {
			clearTimeout(this.flushTimer);
		}
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.writeNow();
		}, FLUSH_DELAY_MS);
	}

	private writeNow(): void {
		try {
			const entries = [...this.map.entries()];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
		} catch (e) {
			console.warn("[nihong-ai] 翻译缓存写入失败:", e);
		}
	}
}
