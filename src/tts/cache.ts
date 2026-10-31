import { logError, logWarn, errMsg } from "../log";

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

/** 持久化适配器：存取音频字节（key → ArrayBuffer）+ LRU 顺序，生产用 IndexedDB，测试用内存 Map */
export interface TTSCacheStorage {
	/** 读取所有条目（启动时加载用） */
	getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]>;
	/** 读取 LRU 顺序（最近使用在前）；无则空数组 */
	getOrder(): Promise<string[]>;
	/** 写入 LRU 顺序 */
	setOrder(order: string[]): Promise<void>;
	/** 写入一条 */
	put(key: string, buffer: ArrayBuffer): Promise<void>;
	/** 删除一条 */
	delete(key: string): Promise<void>;
	/** 清空全部 */
	clear(): Promise<void>;
	/** 关闭底层连接（卸载时调用，释放 DB 连接，避免重载后高版本升级被旧连接阻塞） */
	close?(): Promise<void>;
}

/** TTS 缓存容量（条数，与原纯内存版一致） */
const TTS_CACHE_SIZE = 128;

/** 按引擎推断音频 MIME：windows=audio/wav（PCM），其余（google）=audio/mpeg。
 *  缓存键建 blobUrl 与持久层重建 blobUrl 都用此推断，集中一处避免加引擎时改两处。 */
export function mimeForEngine(engine: string): string {
	return engine === "windows" ? "audio/wav" : "audio/mpeg";
}

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
	 * 用持久层保存的 LRU 顺序（getOrder）决定加载顺序（最近使用在前），保证重启后顺序与关闭前一致。
	 * 加载后超容量的旧条目按 LRU 淘汰（持久层也删）。
	 *
	 * 不加超时：main.ts onload 用 `void initTTSCache()` 不 await，即使 IndexedDB 在 Obsidian 热重载下
	 * 被旧连接阻塞而永久挂起，也不阻塞 Obsidian 启动/朗读（播放走重新合成，不依赖持久层）。
	 * close()（onunload 调）关闭 DB 连接已大幅规避热重载升级阻塞。
	 */
	async load(): Promise<void> {
		if (!this.storage || this.loaded) {
			return;
		}
		try {
			await this.loadFromStorage();
		} catch (e) {
			// 加载失败不阻塞朗读：标记已加载，内存为空，后续重新合成
			logError("tts", `TTS 缓存加载失败: ${errMsg(e)}`);
			this.loaded = true;
		}
	}

	/** 实际从持久层加载字节、重建 blob URL */
	private async loadFromStorage(): Promise<void> {
		const order = await this.storage!.getOrder();
		const all = await this.storage!.getAll();
		// order 是最近使用在前；blobUrls 的 Map 顺序是「最早使用在前」，
		// 故按 order 的逆序（最旧在前）插入，使 entries()（再 reverse）返回与关闭前一致的顺序。
		const bufByKey = new Map(all.map((e) => [e.key, e.buffer]));
		const orderedKeys = order.length > 0 ? [...order].reverse() : all.map((e) => e.key);
		const keep = orderedKeys.slice(0, TTS_CACHE_SIZE).filter((k) => bufByKey.has(k));
		for (const key of keep) {
			// 从 key（engine::voice::text）前缀推断引擎，再推断 mime
			const engine = key.slice(0, key.indexOf("::"));
			const url = URL.createObjectURL(new Blob([bufByKey.get(key)!], { type: mimeForEngine(engine) }));
			this.blobUrls.set(key, url);
		}
		// 淘汰超容量或 order 里多余的旧条目（持久层 audio + order 都清）
		const keepSet = new Set(keep);
		for (const e of all) {
			if (!keepSet.has(e.key)) {
				await this.storage!.delete(e.key);
			}
		}
		await this.storage!.setOrder(keep);
		this.loaded = true;
	}

	/** 取 key 的 blobUrl；命中则 LRU 提升到末尾（最近使用）。未命中/未加载返回 null */
	get(key: string): string | null {
		if (!this.blobUrls.has(key)) {
			return null;
		}
		const url = this.blobUrls.get(key)!;
		this.blobUrls.delete(key);
		this.blobUrls.set(key, url);
		this.persistOrder();
		return url;
	}

	/** 持久化当前内存 LRU 顺序到存储层（最近使用在前 = Map 逆序） */
	private persistOrder(): void {
		if (!this.storage) {
			return;
		}
		const order = [...this.blobUrls.keys()].reverse();
		// fire-and-forget：与 put/delete 一致，rejection 不阻塞调用方，仅记日志
		void this.storage.setOrder(order).catch((e) => {
			logWarn("tts", `TTS 持久化顺序失败: ${errMsg(e)}`);
		});
	}

	/**
	 * 写入一条：存字节到持久层 + 建 blobUrl 到内存层；超容量淘汰最旧（两层 + revoke）。
	 * @param mime 音频 mime type（如 "audio/mpeg"/"audio/wav"），用于 Blob 构造，避免播放失败
	 */
	async set(key: string, buffer: ArrayBuffer, mime?: string): Promise<string> {
		const url = URL.createObjectURL(new Blob([buffer], mime ? { type: mime } : undefined));
		// 覆盖旧条目：先 revoke 旧 blobUrl
		if (this.blobUrls.has(key)) {
			const oldUrl = this.blobUrls.get(key)!;
			this.blobUrls.delete(key);
			URL.revokeObjectURL(oldUrl);
		}
		this.blobUrls.set(key, url);
		// 持久层写入：fire-and-forget，绝不 await——IndexedDB 在 Obsidian 热重载下可能被
		// 旧连接阻塞而永久挂起，await 会导致播放永久卡死。内存层已建好 blobUrl，播放不依赖持久层。
		// 持久化失败/挂起只影响「重启后缓存是否保留」，不影响本次播放。
		if (this.storage) {
			void this.storage.put(key, buffer).catch((e) => {
				logWarn("tts", `TTS 持久化写入失败（不影响播放）: ${errMsg(e)}`);
			});
		}
		// 淘汰超容量：内存层先清（保证不超容）；持久层删除 fire-and-forget
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
				void this.storage.delete(oldestKey).catch(() => {
					// noop
				});
			}
		}
		this.persistOrder();
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

	/** 关闭底层 DB 连接（卸载时调用，避免重载后高版本升级被旧连接阻塞） */
	async close(): Promise<void> {
		if (this.storage?.close) {
			try {
				await this.storage.close();
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
	order: string[] = [];
	async getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]> {
		return [...this.store.entries()].map(([key, buffer]) => ({ key, buffer }));
	}
	async getOrder(): Promise<string[]> {
		return [...this.order];
	}
	async setOrder(order: string[]): Promise<void> {
		this.order = [...order];
	}
	async put(key: string, buffer: ArrayBuffer): Promise<void> {
		this.store.set(key, buffer);
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
	async clear(): Promise<void> {
		this.store.clear();
		this.order = [];
	}
}

/** IndexedDB TTS 缓存数据库名与版本。
 *  注意：曾用名 "nihong-ai-tts-cache"（v1→v2 升级在部分环境卡死，indexedDB.open 永不触发任何事件，
 *  DB 永久损坏无法打开）。改用全新库名 "nihong-ai-tts-cache-v2"，旧库自然废弃（仅占少量磁盘，无副作用）。
 *  v2：store audio（key→ArrayBuffer）+ 保留键 __lru_order__ → string[] 存 LRU 顺序。 */
const TTS_DB_NAME = "nihong-ai-tts-cache-v2";
const TTS_DB_VERSION = 1;
const TTS_STORE = "audio";
/** LRU 顺序存在 audio store 里的保留键（值=string[]）。getAll/put/delete 须跳过此键，不当音频数据 */
const TTS_ORDER_KEY = "__lru_order__";

/**
 * 原生 IndexedDB 版 TTSCacheStorage：store `audio`（key→ArrayBuffer 音频字节，
 * 外加保留键 `__lru_order__` → string[] 存 LRU 顺序）。
 *
 * 不用 idb 库，直接用原生 indexedDB.open，显式处理 success/upgradeneeded/blocked/error，
 * 便于诊断「openDB 永久挂起」问题（idb 在 blocked 事件下默认不 reject、永久挂起，且无日志）。
 * upgrade 幂等兼容所有历史库版本；onunload 调 close() 释放连接，防热重载后升级被旧连接阻塞。
 */
export class IndexedDBTTSCacheStorage implements TTSCacheStorage {
	private dbPromise: Promise<IDBDatabase>;

	constructor() {
		this.dbPromise = openDBNative();
	}

	private async db(): Promise<IDBDatabase> {
		return this.dbPromise;
	}

	async getAll(): Promise<{ key: string; buffer: ArrayBuffer }[]> {
		const db = await this.db();
		return getAllFromStore(db, TTS_STORE, TTS_ORDER_KEY);
	}

	async getOrder(): Promise<string[]> {
		const db = await this.db();
		const value = await getFromStore(db, TTS_STORE, TTS_ORDER_KEY);
		if (Array.isArray(value)) {
			return value.filter((x): x is string => typeof x === "string");
		}
		return [];
	}

	async setOrder(order: string[]): Promise<void> {
		const db = await this.db();
		await putToStore(db, TTS_STORE, order, TTS_ORDER_KEY);
	}

	async put(key: string, buffer: ArrayBuffer): Promise<void> {
		const db = await this.db();
		await putToStore(db, TTS_STORE, buffer, key);
	}

	async delete(key: string): Promise<void> {
		const db = await this.db();
		await deleteFromStore(db, TTS_STORE, key);
	}

	async clear(): Promise<void> {
		const db = await this.db();
		await clearStore(db, TTS_STORE);
	}

	async close(): Promise<void> {
		try {
			const db = await this.db();
			db.close();
		} catch {
			// noop
		}
	}
}

/**
 * 原生 indexedDB.open。不用 idb 库——idb 的 openDB 在 blocked 事件下默认既不 resolve 也不 reject，
 * 会永久挂起且无日志（曾导致「重启后缓存消失」+「朗读卡死」）。原生 API 显式处理 success/blocked/error，
 * blocked 时 reject 而非挂起。upgrade 幂等（缺 store 才建）。onunload 调 close() 释放连接防热重载阻塞。
 */
function openDBNative(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(TTS_DB_NAME, TTS_DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(TTS_STORE)) {
				db.createObjectStore(TTS_STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB open error"));
		req.onblocked = () => reject(new Error("IndexedDB open blocked（另一连接阻塞升级）"));
	});
}

/** 读 store 全部条目，跳过保留键 orderKey（非音频数据） */
function getAllFromStore(
	db: IDBDatabase,
	storeName: string,
	skipKey: string,
): Promise<{ key: string; buffer: ArrayBuffer }[]> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readonly");
		const store = tx.objectStore(storeName);
		const req = store.openCursor();
		const out: { key: string; buffer: ArrayBuffer }[] = [];
		req.onsuccess = () => {
			const cursor: IDBCursorWithValue | null = req.result;
			if (cursor) {
				const key = cursor.key;
				const keyStr = typeof key === "string" ? key : JSON.stringify(key);
				if (keyStr !== skipKey) {
					const value: unknown = cursor.value;
					if (value instanceof ArrayBuffer) {
						out.push({ key: keyStr, buffer: value });
					}
				}
				cursor.continue();
			}
		};
		tx.oncomplete = () => resolve(out);
		tx.onerror = () => reject(toError(tx.error));
	});
}

/** 读 store 单个 key */
function getFromStore(db: IDBDatabase, storeName: string, key: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readonly");
		const req = tx.objectStore(storeName).get(key);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(toError(req.error));
	});
}

/** 写 store 单个 key→value */
function putToStore(
	db: IDBDatabase,
	storeName: string,
	value: unknown,
	key: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.objectStore(storeName).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(toError(tx.error));
	});
}

/** 删 store 单个 key */
function deleteFromStore(db: IDBDatabase, storeName: string, key: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.objectStore(storeName).delete(key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(toError(tx.error));
	});
}

/** 清空 store */
function clearStore(db: IDBDatabase, storeName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.objectStore(storeName).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(toError(tx.error));
	});
}

/** 把 IndexedDB 的 DOMException | null 转成 Error（满足 prefer-promise-reject-errors） */
function toError(e: DOMException | null | undefined): Error {
	return e instanceof Error ? e : new Error("IndexedDB 事务失败");
}
