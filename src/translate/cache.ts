import type { App } from "obsidian";
import { logWarn, errMsg } from "../log";
import { emitCacheChange } from "../cacheEvents";

const STORAGE_KEY = "nihong-ai-translate-cache";
const CAPACITY = 1024;
const FLUSH_DELAY_MS = 500;

/**
 * 缓存持久化适配器：解耦 LRUTranslateCache 与 localStorage。
 * 生产用 AppStorageAdapter（走 App#saveLocalStorage，多 vault 隔离），
 * 测试可注入内存实现（避免依赖 localStorage）。
 */
export interface CacheStorage {
	/** 读取 key 对应的值（已反序列化为对象）；无值返回 null */
	load<T>(key: string): T | null;
	/** 保存值（data=null 表示清除） */
	save(key: string, data: unknown): void;
}

/** 走 Obsidian App 的 vault 级存储适配器（多 vault 隔离，替代直接用 localStorage） */
export class AppStorageAdapter implements CacheStorage {
	constructor(private app: App) {}
	load<T>(key: string): T | null {
		return this.app.loadLocalStorage(key) as T | null;
	}
	save(key: string, data: unknown): void {
		this.app.saveLocalStorage(key, data);
	}
}

/**
 * LRU 翻译缓存。内存用 Map（保持插入顺序，访问时 delete+set 提升为最新），
 * 持久化经 CacheStorage 适配器（生产走 App vault 级存储，防抖写入避免高频写）。
 */
export class LRUTranslateCache {
	private map: Map<string, string> = new Map();
	private flushTimer: number | null = null;
	private storage: CacheStorage | null = null;

	/** 注入持久化适配器（由 TranslateService 在创建时传入 AppStorageAdapter） */
	setStorage(storage: CacheStorage): void {
		this.storage = storage;
	}

	load(): void {
		if (!this.storage) {
			return;
		}
		try {
			const entries = this.storage.load<[string, string][]>(STORAGE_KEY);
			if (!entries) {
				return;
			}
			if (!Array.isArray(entries)) {
				return;
			}
			for (const [k, v] of entries) {
				if (typeof k === "string" && typeof v === "string") {
					this.map.set(k, v);
				}
			}
		} catch (e) {
			logWarn("translate", `翻译缓存加载失败: ${errMsg(e)}`);
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
		const prev = this.map.get(key);
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
		// 仅值变化（新条目或内容更新）才通知，避免 get 的 LRU 提升同值触发无效刷新
		if (prev !== value) {
			emitCacheChange("translate");
		}
	}

	clear(): void {
		this.map.clear();
		if (this.flushTimer != null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.storage) {
			try {
				this.storage.save(STORAGE_KEY, null);
			} catch (e) {
				logWarn("translate", `清空翻译缓存失败: ${errMsg(e)}`);
			}
		}
		emitCacheChange("translate");
	}

	size(): number {
		return this.map.size;
	}

	/**
	 * 返回所有缓存条目，按 LRU 顺序（最近使用在前）返回。
	 * key 是 `JSON.stringify({text, target})`，解析出原文与目标语言。
	 * 供日志面板「翻译缓存」tab 展示。
	 */
	entries(): { text: string; target: string; value: string }[] {
		const out: { text: string; target: string; value: string }[] = [];
		// Map 迭代顺序 = LRU 顺序（最近 set/get 的在末尾），逆序即最近使用在前
		const pairs = [...this.map.entries()].reverse();
		for (const [k, v] of pairs) {
			let text = k;
			let target = "";
			try {
				const parsed = JSON.parse(k) as { text?: string; target?: string };
				if (typeof parsed.text === "string") {
					text = parsed.text;
				}
				if (typeof parsed.target === "string") {
					target = parsed.target;
				}
			} catch {
				// key 不是 JSON（理论不会发生），退化为原样展示
			}
			out.push({ text, target, value: v });
		}
		return out;
	}

	/** 立即写入存储（卸载时调用） */
	flush(): void {
		if (this.flushTimer != null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.writeNow();
	}

	private scheduleFlush(): void {
		if (this.flushTimer != null) {
			window.clearTimeout(this.flushTimer);
		}
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.writeNow();
		}, FLUSH_DELAY_MS);
	}

	private writeNow(): void {
		if (!this.storage) {
			return;
		}
		try {
			const entries = [...this.map.entries()];
			this.storage.save(STORAGE_KEY, entries);
		} catch (e) {
			logWarn("translate", `翻译缓存写入失败: ${errMsg(e)}`);
		}
	}
}
