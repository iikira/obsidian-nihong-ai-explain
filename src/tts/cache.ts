import { openDB, type IDBPDatabase } from "idb";

/**
 * TTS 持久化缓存：内存 blob URL（播放用）+ IndexedDB 音频字节（持久化用）。
 *
 * 朗读缓存原本是纯内存 blob URL Map，重启即失。持久化需存原始音频字节（ArrayBuffer），
 * 重启后从 IndexedDB 加载字节、重建 blob URL。blob URL 无法序列化，故内存仍持 blobUrl 供播放，
 * IndexedDB 持字节作持久层，两者 key 一致（engine::voice::text）。
 *
 * LRU：get/set 提升 key 到末尾（最近使用）；超容量时淘汰最旧——revoke blob URL + 删 IndexedDB 条目。
 * 持久化适配器可注入（生产用 idb 的 IndexedDB，测试用内存实现），便于单测 LRU/淘汰/重建逻辑。
 */

/** 持久化适配器：存取音频字节（key → ArrayBuffer），生产用 IndexedDB，测试用内存 Map */
export interface TTSCacheStorage {
	/** 读取所有条目（启动时加载用） */
	getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]>;
	/** 写入一条 */
	put(key: string, buffer: ArrayBuffer): Promise<void>;
	/** 删除一条 */
	delete(key: string): Promise<void>;
	/** 清空全部 */
	clear(): Promise<void>;
}

/** TTS 缓存容量（条数，与原纯内存版一致） */
const TTS_CACHE_SIZE = 128;

/**
 * TTS 持久化缓存：内存 blobUrl Map + 字节持久层，LRU 淘汰。
 *
 * 内存层：key → blobUrl（播放用，URL.createObjectURL 产物）。
 * 持久层：key → ArrayBuffer（经适配器存 IndexedDB，重启不丢）。
 * 两者 key 同步：set 同时写两层；淘汰/clear 同时清两层 + revoke blobUrl。
 */
export class PersistentTTSCache {
	/** 内存：key → blobUrl（播放用） */
	private blobUrls = new Map<string, string>();
	/** 字节持久层（可注入，生产 IndexedDB / 测试内存） */
	private storage: TTSCacheStorage | null = null;
	/** 是否已从持久层加载完毕 */
	private loaded = false;

	/** 注入持久化适配器（启动时调用，随后调 load） */
	setStorage(storage: TTSCacheStorage): void {
		this.storage = storage;
	}

	/** 是否已从持久层加载完毕（加载前 get 命中 null，调用方会重新合成） */
	isLoaded(): boolean {
		return this.loaded;
	}

	/**
	 * 从持久层加载字节、重建 blob URL 填内存层。
	 * 持久层顺序即 LRU 顺序（写入时已按最近使用排列）。
	 * 加载后超容量的旧条目按 LRU 淘汰（持久层也删）。
	 */
	async load(): Promise<void> {
		if (!this.storage || this.loaded) {
			return;
		}
		try {
			const all = await this.storage.getAll();
			// all 顺序假定最近使用在前（写入时逆序存）；末尾为最旧，超容量从末尾淘汰
			// 重建 blob URL：保留最近 TTS_CACHE_SIZE 条，更旧的从持久层删除
			const keep = all.slice(0, TTS_CACHE_SIZE);
			for (const { key, buffer } of keep) {
				const url = URL.createObjectURL(new Blob([buffer]));
				this.blobUrls.set(key, url);
			}
			// 淘汰超容量的旧条目（持久层）
			const drop = all.slice(TTS_CACHE_SIZE);
			for (const { key } of drop) {
				await this.storage.delete(key);
			}
			this.loaded = true;
		} catch {
			// 加载失败不阻塞朗读：标记已加载，内存为空，后续重新合成
			this.loaded = true;
		}
	}

	/** 取 key 的 blobUrl；命中则 LRU 提升到末尾（最近使用）。未命中/未加载返回 null */
	get(key: string): string | null {
		if (!this.blobUrls.has(key)) {
			return null;
		}
		const url = this.blobUrls.get(key)!;
		this.blobUrls.delete(key);
		this.blobUrls.set(key, url);
		return url;
	}

	/**
	 * 写入一条：存字节到持久层 + 建 blobUrl 到内存层；超容量淘汰最旧（两层 + revoke）。
	 */
	async set(key: string, buffer: ArrayBuffer): Promise<string> {
		const url = URL.createObjectURL(new Blob([buffer]));
		// 覆盖旧条目：先 revoke 旧 blobUrl
		if (this.blobUrls.has(key)) {
			const oldUrl = this.blobUrls.get(key)!;
			this.blobUrls.delete(key);
			URL.revokeObjectURL(oldUrl);
		}
		this.blobUrls.set(key, url);
		// 持久层写入（异步，失败不阻塞播放）
		if (this.storage) {
			try {
				await this.storage.put(key, buffer);
			} catch {
				// 持久化失败不影响内存播放
			}
		}
		// 淘汰超容量：最旧（Map 首部）revoke + 持久层删除
		while (this.blobUrls.size > TTS_CACHE_SIZE) {
			const oldestKey = this.blobUrls.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			const oldUrl = this.blobUrls.get(oldestKey);
			if (oldUrl) {
				URL.revokeObjectURL(oldUrl);
			}
			this.blobUrls.delete(oldestKey);
			if (this.storage) {
				try {
					await this.storage.delete(oldestKey);
				} catch {
					// noop
				}
			}
		}
		return url;
	}

	/** 清空：revoke 全部 blobUrl + 清内存 + 清持久层 */
	async clear(): Promise<void> {
		for (const url of this.blobUrls.values()) {
			URL.revokeObjectURL(url);
		}
		this.blobUrls.clear();
		if (this.storage) {
			try {
				await this.storage.clear();
			} catch {
				// noop
			}
		}
	}

	/** 当前条目数 */
	size(): number {
		return this.blobUrls.size;
	}

	/** 返回所有条目（key → blobUrl），按 LRU 逆序（最近使用在前） */
	entries(): { key: string; blobUrl: string }[] {
		const pairs = [...this.blobUrls.entries()].reverse();
		return pairs.map(([key, blobUrl]) => ({ key, blobUrl }));
	}
}

/** 内存版 TTSCacheStorage（测试用） */
export class MemoryTTSCacheStorage implements TTSCacheStorage {
	store = new Map<string, ArrayBuffer>();
	async getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]> {
		return [...this.store.entries()].map(([key, buffer]) => ({ key, buffer }));
	}
	async put(key: string, buffer: ArrayBuffer): Promise<void> {
		this.store.set(key, buffer);
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
	async clear(): Promise<void> {
		this.store.clear();
	}
}

/** IndexedDB TTS 缓存数据库名与版本 */
const TTS_DB_NAME = "nihong-ai-tts-cache";
const TTS_DB_VERSION = 1;
const TTS_STORE = "audio";

/**
 * IndexedDB 版 TTSCacheStorage：单 store `audio`，keyPath = key（engine::voice::text），value = ArrayBuffer。
 * 生产用，启动时由 main.ts 创建并注入 PersistentTTSCache。
 */
export class IndexedDBTTSCacheStorage implements TTSCacheStorage {
	private dbPromise: Promise<IDBPDatabase<unknown>>;

	constructor() {
		this.dbPromise = openDB(TTS_DB_NAME, TTS_DB_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(TTS_STORE)) {
					db.createObjectStore(TTS_STORE);
				}
			},
		});
	}

	async getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]> {
		const db = await this.dbPromise;
		const keys = await db.getAllKeys(TTS_STORE);
		const out: { key: string; buffer: ArrayBuffer }[] = [];
		for (const key of keys) {
			// IDBValidKey 可能是 string | number | Date | ArrayBuffer，统一转 string 作 key
			const keyStr =
				typeof key === "string" ? key : JSON.stringify(key);
			const value: unknown = await db.get(TTS_STORE, key);
			if (value instanceof ArrayBuffer) {
				out.push({ key: keyStr, buffer: value });
			}
		}
		return out;
	}

	async put(key: string, buffer: ArrayBuffer): Promise<void> {
		const db = await this.dbPromise;
		await db.put(TTS_STORE, buffer, key);
	}

	async delete(key: string): Promise<void> {
		const db = await this.dbPromise;
		await db.delete(TTS_STORE, key);
	}

	async clear(): Promise<void> {
		const db = await this.dbPromise;
		await db.clear(TTS_STORE);
	}
}
