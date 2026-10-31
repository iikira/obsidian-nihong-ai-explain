import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { unzipSync } from "fflate";
import { Notice, normalizePath, requestUrl, type App } from "obsidian";
import { Deinflector } from "./deinflector";
import { AccentDb } from "./accents";
import { compareRevisions } from "./revision";
import { ACCENTS_B64_GZ } from "./data/accentsData";
import { logInfo, logWarn, logError, errMsg } from "../log";
import type {
	DictionaryMeta,
	LookupResult,
	ProcessedTag,
	ProcessedTerm,
	RawTagEntry,
	RawTermEntry,
} from "./types";

export interface YomitanDB extends DBSchema {
	terms: {
		key: number;
		value: ProcessedTerm;
		indexes: { expression: string; reading: string };
	};
	dictionaries: {
		key: string;
		value: DictionaryMeta;
	};
	tag_defs: {
		key: string;
		value: ProcessedTag;
	};
}

const DB_NAME = "nihong-ai-dict";
const DB_VERSION = 1;

/** Jitendex 词典源常量（GitHub release：stephenmk/stephenmk.github.io） */
const JITENDEX_DOWNLOAD_URL =
	"https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip";
const JITENDEX_RELEASES_API =
	"https://api.github.com/repos/stephenmk/stephenmk.github.io/releases/latest";
const JITENDEX_ZIP_NAME = "jitendex-yomitan.zip";

/** JMnedict 词典源常量（GitHub release：yomidevs/jmdict-yomitan）
 *  JMnedict 无 releases-API tag，更新检查走 indexUrl（GET 后读 revision 字段） */
const JMNEDICT_ZIP_NAME = "JMnedict.zip";
const JMNEDICT_DOWNLOAD_URL =
	"https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip";
const JMNEDICT_INDEX_URL =
	"https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json";
/** JMnedict 独立 IndexedDB 库名（与 Jitendex 库 nihong-ai-dict 分离，互不影响） */
const JMNEDICT_DB_NAME = "nihong-ai-dict-names";

/** Jitendex 安装/更新的阶段（供 UI 显示进度文案） */
export type JitendexStage =
	| "fetching"    // 拉取最新版本号 / 读取本地 zip 版本
	| "downloading" // 下载 zip（最慢，几十 MB）
	| "installing"  // 清空旧库 + 导入新数据
	| "done";       // 完成

/** 安装/更新进度回调：dictName 标识哪本词典，stage 标识阶段 */
export type DictProgressCb = (dictName: string, stage: JitendexStage) => void;

/** 分片下载的请求函数签名（与 obsidian 的 requestUrl 一致，抽出可注入以便测试 mock） */
export type ChunkRequestFn = (params: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	throw?: boolean;
}) => Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }>;

/** 文件适配器（与 Obsidian DataAdapter 的方法子集一致，可注入 mock）：
 *  分片下载用 writeBinary/appendBinary/remove；读本地 zip 版本 + 读下载的 zip 用 exists/readBinary。 */
export interface ChunkFileAdapter {
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	appendBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	readBinary(path: string): Promise<ArrayBuffer>;
}

/** 分片下载选项 */
interface ChunkDownloadOptions {
	/** 单片大小（字节） */
	chunkSize: number;
	/** 单分片失败的最大重试次数（含首次） */
	maxRetries: number;
	/** 单分片重试间隔（ms） */
	retryInterval: number;
}

/**
 * 分片下载（HTTP Range）到文件：先 HEAD 拿总大小，按 chunkSize 分片逐块下载并追加写入。
 *
 * 移动端 requestUrl/fetch 会把整个响应体 base64 编码后传回 JS 层——整包下载几十 MB 的
 * zip 会让 Java 堆（256MB 限制）OOM 闪退。按 5MB 分片，每片 base64 后约 6.7MB，避免 OOM。
 *
 * 单分片请求失败重试最多 maxRetries 次（含首次），每次失败后等待 retryInterval；
 * 超出重试次数后清理已下载的部分文件并抛错（整体失败）。
 *
 * 抽为模块级纯函数（接收 requestFn / adapter 注入），便于单元测试 mock。
 */
export async function downloadChunked(
	requestFn: ChunkRequestFn,
	adapter: ChunkFileAdapter,
	url: string,
	path: string,
	opts: ChunkDownloadOptions,
): Promise<void> {
	// 1. HEAD 拿总大小（Content-Length）
	const headResp = await requestFn({ url, method: "HEAD", throw: false });
	if (headResp.status < 200 || headResp.status >= 300) {
		throw new Error(`HEAD 失败: HTTP ${headResp.status}`);
	}
	const totalStr = headResp.headers["content-length"] ?? headResp.headers["Content-Length"];
	const total = totalStr ? parseInt(totalStr, 10) : NaN;
	if (!Number.isFinite(total) || total <= 0) {
		throw new Error(`无法获取文件大小（Content-Length=${totalStr ?? "缺失"}），可能不支持分片下载`);
	}

	// 2. 分片下载并追加写入文件
	const { chunkSize, maxRetries, retryInterval } = opts;
	let downloaded = 0;
	let first = true;
	const cleanup = async (reason: string): Promise<void> => {
		logWarn("dict", `分片下载失败，清理已下载文件: ${reason}`);
		try {
			await adapter.remove(path);
		} catch {
			// 文件可能不存在，忽略清理错误
		}
	};
	try {
		while (downloaded < total) {
			const end = Math.min(downloaded + chunkSize - 1, total - 1);
			// 单分片请求重试：最多 maxRetries 次（含首次）
			let buf: ArrayBuffer | null = null;
			let status = 0;
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					const resp = await requestFn({
						url,
						method: "GET",
						headers: { Range: `bytes=${downloaded}-${end}` },
						throw: false,
					});
					// 206 Partial Content（分片）或 200（服务器忽略 Range 返回整包）
					if (resp.status !== 206 && resp.status !== 200) {
						throw new Error(`HTTP ${resp.status}`);
					}
					if (!resp.arrayBuffer || resp.arrayBuffer.byteLength === 0) {
						throw new Error("响应体为空");
					}
					buf = resp.arrayBuffer;
					status = resp.status;
					break;
				} catch (e) {
					if (attempt < maxRetries) {
						logWarn("dict", `分片下载失败（第 ${attempt}/${maxRetries} 次，bytes=${downloaded}-${end}），重试: ${errMsg(e)}`);
						await sleep(retryInterval);
					} else {
						throw new Error(`分片下载失败（已重试 ${maxRetries} 次，bytes=${downloaded}-${end}）: ${errMsg(e)}`);
					}
				}
			}
			if (!buf) {
				throw new Error(`分片下载失败: 未能获取数据（bytes=${downloaded}-${end}）`);
			}
			if (first) {
				// 第一片覆盖写（清掉旧文件）
				await adapter.writeBinary(path, buf);
				first = false;
			} else {
				// 后续片追加写
				await adapter.appendBinary(path, buf);
			}
			downloaded += buf.byteLength;
			// 服务器若忽略 Range 返回整包（200），一次就下完，跳出循环
			if (status === 200) {
				break;
			}
		}
	} catch (e) {
		await cleanup(errMsg(e));
		throw new Error(`下载失败: ${errMsg(e)}`);
	}

	if (downloaded === 0) {
		await cleanup("未下载到任何数据");
		throw new Error("下载失败: 未下载到任何数据");
	}
	logInfo("dict", `分片下载完成: ${downloaded}/${total} 字节`);
}

/** 单本词典源状态（供设置页展示与更新判断） */
export interface DictSourceStatus {
	/** 词典标识（占位名如 "Jitendex"/"JMnedict"；已导入则用实际 title） */
	title: string;
	/** 是否已导入 */
	installed: boolean;
	/** 已导入词典的 revision（无导入则 null） */
	installedRevision: string | null;
	/** 最新版本（拉取失败则 null） */
	latestRevision: string | null;
	/** latestRevision 非空且与 installedRevision 不同 */
	hasUpdate: boolean;
}

/** 聚合多词典源信息（供设置页展示与一键更新判断） */
export interface DictSourceInfo {
	/** 各词典源状态（Jitendex、JMnedict） */
	sources: DictSourceStatus[];
	/** 任意一个 hasUpdate */
	anyHasUpdate: boolean;
	/** 任意一个已导入 */
	anyInstalled: boolean;
}

/** 单个词典源的更新描述（updateDictionaries 内部用，写死 Jitendex/JMnedict 各一组） */
interface UpdateSource {
	name: string;
	zipName: string;
	downloadUrl: string;
	db: IDBPDatabase<YomitanDB> | null;
	latestRevision: string | null;
	installedRevision: string | null;
	installed: boolean;
}

export class DictionaryManager {
	private db: IDBPDatabase<YomitanDB> | null = null;
	/** JMnedict 独立库（与 Jitendex 库分离，互不影响） */
	private dbNames: IDBPDatabase<YomitanDB> | null = null;
	private deinflector: Deinflector;
	private app: App | null = null;
	private pluginDir: string | null = null;
	private accentDb: AccentDb = new AccentDb();
	/** 网络请求函数（默认 obsidian requestUrl；测试可注入 mock，便于测 fetch 及 updateDictionaries） */
	private requestFn: typeof requestUrl = requestUrl;
	/** 文件适配器（默认 this.app.vault.adapter；测试可注入内存版，便于测 updateDictionaries/readLocalZipRevision） */
	private fileAdapter: ChunkFileAdapter | null = null;
	/** fetchLatestRevision 的会话内缓存值（null=未知或拉取失败）；命中缓存时不打 GitHub API */
	private latestRevisionCache: string | null = null;
	/** latestRevisionCache 的过期时间戳（ms）；过期后重新拉取。拉取失败则缩短缓存时间 */
	private latestRevisionCacheExpire = 0;
	/** fetchJMnedictLatestRevision 的会话内缓存（独立于 Jitendex 缓存） */
	private jmnedictLatestCache: string | null = null;
	private jmnedictLatestCacheExpire = 0;
	/** latestRevision 缓存有效期（成功拉取后）：10 分钟 */
	private static readonly LATEST_REV_TTL = 10 * 60 * 1000;
	/** latestRevision 拉取失败后的重试间隔（失败也短暂缓存，避免短时反复撞限流）：1 分钟 */
	private static readonly LATEST_REV_FAIL_TTL = 60 * 1000;

	constructor() {
		this.deinflector = new Deinflector();
	}

	setApp(app: App): void {
		this.app = app;
	}

	setPluginDir(dir: string): void {
		this.pluginDir = dir;
	}

	/** 注入网络请求函数（测试用，默认 obsidian requestUrl） */
	setRequestFn(fn: typeof requestUrl): void {
		this.requestFn = fn;
	}

	/** 注入文件适配器（测试用，默认 this.app.vault.adapter） */
	setFileAdapter(adapter: ChunkFileAdapter | null): void {
		this.fileAdapter = adapter;
	}

	/** 取当前文件适配器（优先用注入的，否则用 app.vault.adapter） */
	private getAdapter(): ChunkFileAdapter | null {
		if (this.fileAdapter) {
			return this.fileAdapter;
		}
		if (this.app) {
			return this.app.vault.adapter;
		}
		return null;
	}

	async init(): Promise<void> {
		try {
			this.db = await openDB<YomitanDB>(DB_NAME, DB_VERSION, {
				upgrade: (db) => DictionaryManager.upgradeSchema(db),
			});
			// JMnedict 独立库（与 Jitendex 库分离，互不影响；结构一致）
			this.dbNames = await openDB<YomitanDB>(JMNEDICT_DB_NAME, 1, {
				upgrade: (db) => DictionaryManager.upgradeSchema(db),
			});
			await this.loadAccents();
		} catch (e) {
			logError("dict", `IndexedDB 初始化失败: ${errMsg(e)}`);
		}
	}

	/** 两库共用 IndexedDB schema：terms(expression/reading 索引) + dictionaries(title) + tag_defs(name) */
	private static upgradeSchema(db: IDBPDatabase<YomitanDB>): void {
		const termStore = db.createObjectStore("terms", {
			autoIncrement: true,
		});
		termStore.createIndex("expression", "expression", {
			unique: false,
		});
		termStore.createIndex("reading", "reading", { unique: false });
		db.createObjectStore("dictionaries", { keyPath: "title" });
		db.createObjectStore("tag_defs", { keyPath: "name" });
	}

	/** 用内置的 accents 文本（构建时 gzip+base64 打包进 bundle）加载声调索引 */
	private async loadAccents(): Promise<void> {
		try {
			// base64 解码 → gzip 解压（浏览器原生 DecompressionStream，桌面/移动端均支持）
			const binStr = atob(ACCENTS_B64_GZ);
			const bytes = new Uint8Array(binStr.length);
			for (let i = 0; i < binStr.length; i++) {
				bytes[i] = binStr.charCodeAt(i);
			}
			const ds = new DecompressionStream("gzip");
			const decompressed = new Response(new Blob([bytes]).stream().pipeThrough(ds));
			const text = await decompressed.text();
			this.accentDb.load(text);
		} catch (e) {
			logWarn("dict", `加载声调索引失败: ${errMsg(e)}`);
		}
	}

	/** 是否已加载声调数据 */
	get hasAccents(): boolean {
		return this.accentDb.isLoaded;
	}

	/** 查询某 expression+reading 的候选声调位置（无数据返回空数组） */
	getAccents(expression: string, reading: string): number[] {
		return this.accentDb.lookup(expression, reading);
	}

	get isReady(): boolean {
		return this.db != null;
	}

	async isImported(): Promise<boolean> {
		// 任一库有词典即视为已导入
		if (!this.db) {
			return false;
		}
		try {
			const count = await this.db.count("dictionaries");
			if (count > 0) {
				return true;
			}
			if (this.dbNames) {
				const count2 = await this.dbNames.count("dictionaries");
				return count2 > 0;
			}
			return false;
		} catch {
			return false;
		}
	}

	/** 查单个库的 dictionaries */
	private async getDictionariesInDb(db: IDBPDatabase<YomitanDB> | null): Promise<DictionaryMeta[]> {
		if (!db) {
			return [];
		}
		return await db.getAll("dictionaries");
	}

	async getDictionaries(): Promise<DictionaryMeta[]> {
		// 聚合两库的 dictionaries
		const r1 = await this.getDictionariesInDb(this.db);
		const r2 = await this.getDictionariesInDb(this.dbNames);
		return [...r1, ...r2];
	}

	/** 清单个库的 terms + dictionaries + tag_defs */
	private async clearDb(db: IDBPDatabase<YomitanDB> | null): Promise<void> {
		if (!db) {
			return;
		}
		await db.clear("terms");
		await db.clear("dictionaries");
		await db.clear("tag_defs");
	}

	async clear(): Promise<void> {
		// 清两个库（「清空词典」按钮用）
		await this.clearDb(this.db);
		await this.clearDb(this.dbNames);
	}

	/** 解压 zip 字节并导入 Jitendex 库（供「从插件目录导入」与「下载导入」共用） */
	async importFromZipBuffer(buf: ArrayBuffer): Promise<void> {
		await this.importFromZipBufferInto(this.db, buf);
	}

	/** 解压 zip 字节并导入 JMnedict 人名库（与 importFromZipBuffer 对称，导入 dbNames） */
	async importNamesFromZipBuffer(buf: ArrayBuffer): Promise<void> {
		await this.importFromZipBufferInto(this.dbNames, buf);
	}

	/** 解压 zip 字节并导入指定库（库无关，Jitendex/JMnedict 库共用；public 供测试 + 通用导入） */
	async importFromZipBufferInto(db: IDBPDatabase<YomitanDB> | null, buf: ArrayBuffer): Promise<void> {
		if (!db) {
			return;
		}
		const files = unzipSync(new Uint8Array(buf));
		await this.processZipFiles(db, files);
	}

	/** 词典 zip 在插件目录下的 vault 相对路径（通用，按 zip 文件名） */
	private dictZipPath(zipName: string): string | null {
		if (!this.pluginDir) {
			return null;
		}
		return normalizePath(`${this.pluginDir}/${zipName}`);
	}

	/** 分片大小（5MB）：移动端 requestUrl/fetch 会把响应体 base64 编码后传回 JS 层，
	 * 整包下载几十 MB 的 zip 会让 Java 堆（256MB 限制）OOM 闪退。按 5MB 分片下载，
	 * 每片 base64 后约 6.7MB，远低于堆限制，避免 OOM。GitHub release assets 支持 Range 请求。 */
	private static readonly CHUNK_SIZE = 5 * 1024 * 1024;
	/** 单分片下载失败的最大重试次数（含首次） */
	private static readonly CHUNK_MAX_RETRIES = 3;
	/** 单分片重试间隔（ms） */
	private static readonly CHUNK_RETRY_INTERVAL = 2000;

	/**
	 * 下载 jitendex-yomitan.zip 到插件目录（覆盖旧 zip），返回 zip 路径。
	 *
	 * 分片下载（HTTP Range）：先 HEAD 拿总大小，按 5MB 分片逐块下载并追加写入文件。
	 * 移动端 Obsidian 的 requestUrl/fetch 都由 Capacitor 的 requestUrlAndroid 实现，
	 * 会把整个响应体 base64 编码后传回 JS 层——整包下载几十 MB 的 zip 时 Java 堆
	 * （256MB 限制）OOM 闪退（崩溃栈：Base64.encodeToString → OutOfMemoryError）。
	 * 按 5MB 分片，每片 base64 后约 6.7MB，远低于堆限制，避免 OOM。
	 * 桌面端同样走分片（统一路径，桌面端整包也正常但分片无害）。
	 * 单分片失败重试最多 3 次，超出后清理已下载文件、整体失败。
	 */
	/** 下载指定词典 zip 到插件目录（覆盖旧 zip），返回 zip 路径。库无关，按 url + zipName 下载 */
	private async downloadDictZip(url: string, zipName: string): Promise<string> {
		const adapter = this.getAdapter();
		if (!adapter || !this.pluginDir) {
			throw new Error("插件目录未配置，无法保存下载文件");
		}
		const zipPath = this.dictZipPath(zipName);
		if (!zipPath) {
			throw new Error("插件目录未配置");
		}
		await downloadChunked(this.requestFn, adapter, url, zipPath, {
			chunkSize: DictionaryManager.CHUNK_SIZE,
			maxRetries: DictionaryManager.CHUNK_MAX_RETRIES,
			retryInterval: DictionaryManager.CHUNK_RETRY_INTERVAL,
		});
		return zipPath;
	}

	/**
	 * GitHub releases/latest → tag_name；失败返回 null，不抛。
	 * 会话内缓存（成功 10 分钟、失败 1 分钟），避免频繁打开设置页 / 点更新时
	 * 反复打 GitHub API 撞上未认证 60 次/小时/IP 限流。
	 */
	async fetchLatestRevision(): Promise<string | null> {
		// 命中缓存（未过期）直接返回，不发请求
		if (Date.now() < this.latestRevisionCacheExpire) {
			return this.latestRevisionCache;
		}
		try {
			const resp = await this.requestFn({
				url: JITENDEX_RELEASES_API,
				method: "GET",
				headers: { Accept: "application/vnd.github+json" },
				throw: false,
			});
			if (resp.status < 200 || resp.status >= 300) {
				// 解析 GitHub 错误响应体，给出更具体的失败原因（如速率限制）
				let detail = "";
				try {
					const body = resp.json as { message?: string } | null;
					if (body?.message) {
						detail = `: ${body.message}`;
					}
				} catch {
					// 非 JSON 响应体，忽略
				}
				// 403 通常是未认证请求的速率限制（60 次/小时/IP）
				const hint = resp.status === 403
					? "（GitHub API 未认证请求限流 60 次/小时/IP，稍后重试或复用本地 zip）"
					: "";
				logWarn(
					"nihong-ai",
					`拉取 Jitendex 最新版本失败: HTTP ${resp.status}${detail}${hint}`,
				);
				// 失败也短暂缓存 null，避免短时反复重试撞限流
				this.latestRevisionCache = null;
				this.latestRevisionCacheExpire =
					Date.now() + DictionaryManager.LATEST_REV_FAIL_TTL;
				return null;
			}
			const tag = (resp.json as { tag_name?: string }).tag_name;
			const rev = typeof tag === "string" && tag ? tag : null;
			this.latestRevisionCache = rev;
			this.latestRevisionCacheExpire =
				Date.now() + DictionaryManager.LATEST_REV_TTL;
			return rev;
		} catch (e) {
			logWarn("dict", `拉取 Jitendex 最新版本出错: ${errMsg(e)}`);
			this.latestRevisionCache = null;
			this.latestRevisionCacheExpire =
				Date.now() + DictionaryManager.LATEST_REV_FAIL_TTL;
			return null;
		}
	}

	/**
	 * JMnedict 最新版本：GET indexUrl（/latest/download/JMnedict.json，302 重定向，requestUrl 自动跟随）
	 * → 读 revision 字段。失败返回 null，不抛。会话内缓存（同 Jitendex TTL 策略），独立缓存字段。
	 */
	async fetchJMnedictLatestRevision(): Promise<string | null> {
		if (Date.now() < this.jmnedictLatestCacheExpire) {
			return this.jmnedictLatestCache;
		}
		try {
			const resp = await this.requestFn({
				url: JMNEDICT_INDEX_URL,
				method: "GET",
				throw: false,
			});
			if (resp.status < 200 || resp.status >= 300) {
				logWarn("dict", `拉取 JMnedict 最新版本失败: HTTP ${resp.status}`);
				this.jmnedictLatestCache = null;
				this.jmnedictLatestCacheExpire =
					Date.now() + DictionaryManager.LATEST_REV_FAIL_TTL;
				return null;
			}
			const rev = (resp.json as { revision?: string }).revision ?? null;
			const v = typeof rev === "string" && rev ? rev : null;
			this.jmnedictLatestCache = v;
			this.jmnedictLatestCacheExpire =
				Date.now() + DictionaryManager.LATEST_REV_TTL;
			return v;
		} catch (e) {
			logWarn("dict", `拉取 JMnedict 最新版本出错: ${errMsg(e)}`);
			this.jmnedictLatestCache = null;
			this.jmnedictLatestCacheExpire =
				Date.now() + DictionaryManager.LATEST_REV_FAIL_TTL;
			return null;
		}
	}

	/** 聚合各词典源已导入版本与最新版本信息（供设置页展示与一键更新判断） */
	async getSourceInfo(): Promise<DictSourceInfo> {
		// Jitendex：查 Jitendex 库（title 含 "Jitendex"）
		const jitDicts = await this.getDictionariesInDb(this.db);
		const jitInstalled = jitDicts.find((d) => d.title.includes("Jitendex"));
		const jitLatest = await this.fetchLatestRevision();
		const jitHasUpdate =
			jitLatest !== null &&
			jitInstalled != null &&
			jitLatest !== (jitInstalled.revision ?? null);
		// JMnedict：查 JMnedict 库（title 含 "JMnedict"）
		const jmDicts = await this.getDictionariesInDb(this.dbNames);
		const jmInstalled = jmDicts.find((d) => d.title.includes("JMnedict"));
		const jmLatest = await this.fetchJMnedictLatestRevision();
		const jmHasUpdate =
			jmLatest !== null &&
			jmInstalled != null &&
			jmLatest !== (jmInstalled.revision ?? null);
		const sources: DictSourceStatus[] = [
			{
				title: jitInstalled?.title ?? "Jitendex",
				installed: jitInstalled != null,
				installedRevision: jitInstalled?.revision ?? null,
				latestRevision: jitLatest,
				hasUpdate: jitHasUpdate,
			},
			{
				title: jmInstalled?.title ?? "JMnedict",
				installed: jmInstalled != null,
				installedRevision: jmInstalled?.revision ?? null,
				latestRevision: jmLatest,
				hasUpdate: jmHasUpdate,
			},
		];
		return {
			sources,
			anyHasUpdate: jitHasUpdate || jmHasUpdate,
			anyInstalled: jitInstalled != null || jmInstalled != null,
		};
	}

	/**
	 * 读取插件目录下指定 zip 内 index.json 的 revision；无文件/解析失败返回 null。
	 * 库无关，按 zipName 定位本地 zip。
	 */
	private async readLocalZipRevision(zipName: string): Promise<string | null> {
		const adapter = this.getAdapter();
		if (!adapter || !this.pluginDir) {
			return null;
		}
		const zipPath = this.dictZipPath(zipName);
		if (!zipPath) {
			return null;
		}
		try {
			if (!(await adapter.exists(zipPath))) {
				return null;
			}
			const buf = await adapter.readBinary(zipPath);
			const files = unzipSync(new Uint8Array(buf));
			const indexKey = Object.keys(files).find((k) =>
				k.endsWith("index.json"),
			);
			if (!indexKey) {
				return null;
			}
			const meta = JSON.parse(
				new TextDecoder().decode(files[indexKey]),
			) as DictionaryMeta;
			return meta.revision ?? null;
		} catch (e) {
			logWarn("dict", `读取本地 zip 版本失败: ${errMsg(e)}`);
			return null;
		}
	}

	/**
	 * 一键安装/更新所有词典（Jitendex + JMnedict）：
	 * - 并行下载需更新的源（各到各 zip 路径，互不干扰，省一半下载等待）
	 * - 串行导入（await importFromZipBufferInto 逐本——避免 IndexedDB 写入并发冲突 + stage 文案清晰）
	 * - 各源独立 clearDb（整库 clear = per-dict clear，不影响另一本）
	 * 返回 { updatedCount }：实际更新/安装了几本。已是最新未变更的不计。
	 */
	async updateDictionaries(onProgress?: DictProgressCb): Promise<{ updatedCount: number }> {
		// 1. 收集各源状态
		const info = await this.getSourceInfo();
		const sources: UpdateSource[] = [
			{
				name: "Jitendex",
				zipName: JITENDEX_ZIP_NAME,
				downloadUrl: JITENDEX_DOWNLOAD_URL,
				db: this.db,
				latestRevision: info.sources[0].latestRevision,
				installedRevision: info.sources[0].installedRevision,
				installed: info.sources[0].installed,
			},
			{
				name: "JMnedict",
				zipName: JMNEDICT_ZIP_NAME,
				downloadUrl: JMNEDICT_DOWNLOAD_URL,
				db: this.dbNames,
				latestRevision: info.sources[1].latestRevision,
				installedRevision: info.sources[1].installedRevision,
				installed: info.sources[1].installed,
			},
		];

		// 2. 决定各源是否需下载 + zip 路径（复用本地 zip 或下载）
		//    需更新的源：已导入==latest 且已导入 → 跳过；否则需获取 zip
		type DownloadTask = { source: UpdateSource; zipPath: string | null; needDownload: boolean };
		const tasks: DownloadTask[] = [];
		for (const source of sources) {
			onProgress?.(source.name, "fetching");
			// 已导入且与最新一致 → 跳过该源
			if (source.installed && source.latestRevision && source.latestRevision === source.installedRevision) {
				tasks.push({ source, zipPath: null, needDownload: false });
				continue;
			}
			const localRev = await this.readLocalZipRevision(source.zipName);
			let zipPath = this.dictZipPath(source.zipName);
			let needDownload = true;
			if (source.latestRevision && localRev && localRev === source.latestRevision) {
				// 本地 zip 版本与最新一致，复用，跳过下载
				needDownload = false;
			} else if (!source.latestRevision && localRev) {
				// API 失败无法判断最新版，复用本地 zip 前校验：不比已导入的低才装
				if (source.installed && source.installedRevision && compareRevisions(localRev, source.installedRevision) <= 0) {
					// 本地不比已导入新，跳过
					tasks.push({ source, zipPath: null, needDownload: false });
					continue;
				}
				needDownload = false;
			}
			tasks.push({ source, zipPath, needDownload });
		}

		// 3. 并行下载需下载的源（各到各 zip 路径）
		const downloadTasks = tasks.filter((t) => t.needDownload);
		if (downloadTasks.length > 0) {
			for (const t of downloadTasks) {
				onProgress?.(t.source.name, "downloading");
			}
			await Promise.all(
				downloadTasks.map(async (t) => {
					const p = await this.downloadDictZip(t.source.downloadUrl, t.source.zipName);
					t.zipPath = p;
				}),
			);
		}

		// 4. 串行导入需更新的源（clearDb 该库 + importFromZipBufferInto）
		let updatedCount = 0;
		for (const t of tasks) {
			if (!t.zipPath) {
				continue;
			}
			onProgress?.(t.source.name, "installing");
			const adapter = this.getAdapter();
			if (!adapter) {
				throw new Error("文件适配器未配置，无法读取下载的 zip");
			}
			const buf = await adapter.readBinary(t.zipPath);
			await this.clearDb(t.source.db);
			await this.importFromZipBufferInto(t.source.db, buf);
			onProgress?.(t.source.name, "done");
			updatedCount++;
		}
		return { updatedCount };
	}

	async processZipFiles(db: IDBPDatabase<YomitanDB>, files: Record<string, Uint8Array>): Promise<void> {
		new Notice("正在导入词典…", 3000);

		// 1. index.json（仅解析，暂不写入 dictionaries store）
		//    重要：版本号（meta.revision）必须等所有词条 + tag 都导入成功后才写入，
		//    防止导入中途程序退出后，dictionaries 已记新版本号但词条不完整，
		//    再次打开时被getSourceInfo 误判为「已是最新」而不再补导。
		let meta: DictionaryMeta | null = null;
		const indexKey = Object.keys(files).find((k) => k.endsWith("index.json"));
		if (indexKey) {
			try {
				const txt = new TextDecoder().decode(files[indexKey]);
				meta = JSON.parse(txt) as DictionaryMeta;
			} catch (e) {
				throw new Error(`解析 index.json 失败: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (!meta || !meta.title) {
			throw new Error("zip 缺少有效的 index.json");
		}

		// 2. term_bank_*.json（先导入所有词条）
		const termKeys = Object.keys(files)
			.filter((k) => k.includes("term_bank_") && k.endsWith(".json"))
			.sort();
		let totalTerms = 0;
		let termParseFailed = false;
		for (const key of termKeys) {
			try {
				const txt = new TextDecoder().decode(files[key]);
				const rawTerms = JSON.parse(txt) as RawTermEntry[];
				const tx = db.transaction("terms", "readwrite");
				for (const entry of rawTerms) {
					const rest = entry.slice(5);
					// Jitendex 把整个 glossary 包进单个数组元素（rest[0] 是数组），
					// 后跟 seqId + attribution；标准 Yomitan 则是展开的多项（string/object）。
					// 启发式：rest[0] 是数组 → 解包作为 glossary。
					const glossary: unknown[] = Array.isArray(rest[0])
						? (rest[0] as unknown[])
						: rest;
					const term: ProcessedTerm = {
						expression: entry[0],
						reading: entry[1],
						tags: entry[2] ? entry[2].split(" ") : [],
						rules: entry[3] ? entry[3].split(" ") : [],
						score: entry[4],
						glossary,
						dictionary: meta.title,
					};
					await tx.store.add(term);
					totalTerms++;
				}
				await tx.done;
			} catch (e) {
				termParseFailed = true;
				logWarn("dict", `解析 ${key} 失败: ${errMsg(e)}`);
			}
		}

		// 3. tag_bank_*.json
		const tagKeys = Object.keys(files)
			.filter((k) => k.includes("tag_bank_") && k.endsWith(".json"))
			.sort();
		for (const key of tagKeys) {
			try {
				const txt = new TextDecoder().decode(files[key]);
				const rawTags = JSON.parse(txt) as RawTagEntry[];
				const tx = db.transaction("tag_defs", "readwrite");
				for (const t of rawTags) {
					const tag: ProcessedTag = {
						name: t[0],
						category: t[1],
						order: t[2],
						notes: t[3],
						score: t[4],
						short: t[5],
						dictionary: meta.title,
					};
					await tx.store.put(tag);
				}
				await tx.done;
			} catch (e) {
				logWarn("dict", `解析 ${key} 失败: ${errMsg(e)}`);
			}
		}

		// 4. 最后才写入 dictionaries（含版本号 revision）——仅当词条全部导入成功时。
		//    保证「dictionaries 有版本号 ⟺ 词条完整」：
		//    - 导入中途程序退出：dictionaries 无新版本号 → 再开判为未安装/需更新，触发重导。
		//    - term_bank 解析失败（损坏 JSON 等）：不写版本号 + 抛错，调用方 updateDictionaries
		//      不计为成功，再开判为需更新，触发重导，不会误判为「已是最新」。
		//    修复前：先写版本号再导词条，中途退出/解析失败后版本号已写入，再开误判为已最新、词条残缺。
		if (termParseFailed || totalTerms === 0) {
			throw new Error(
				`词典词条导入失败（解析失败=${termParseFailed}，词条数=${totalTerms}），不写入版本号`,
			);
		}
		await db.put("dictionaries", meta);

		new Notice(`词典导入完成: ${totalTerms} 条`, 5000);
	}

	private isValidDeinflection(
		deinflectRules: number,
		termRules: string[]
	): boolean {
		if (deinflectRules === 0) {
			return true;
		}
		const termFlags = this.deinflector.getRuleFlags(termRules);
		if (termFlags === 0) {
			return false;
		}
		return (deinflectRules & termFlags) !== 0;
	}

	/** 查单个库的 terms（expression/reading 索引 + deinflect + signature 去重） */
	private async lookupInDb(db: IDBPDatabase<YomitanDB> | null, text: string): Promise<LookupResult[]> {
		if (!db) {
			return [];
		}
		const candidates = this.deinflector.deinflect(text);
		const rawResults: LookupResult[] = [];
		for (const candidate of candidates) {
			const term = candidate.term;
			const expressionMatches = await db.getAllFromIndex(
				"terms",
				"expression",
				term
			);
			const readingMatches = await db.getAllFromIndex(
				"terms",
				"reading",
				term
			);
			const rawMatches = [...expressionMatches, ...readingMatches];
			for (const match of rawMatches) {
				if (!this.isValidDeinflection(candidate.rules, match.rules)) {
					continue;
				}
				rawResults.push({
					...match,
					deinflectionReasons:
						candidate.reasons.length > 0 ? candidate.reasons : undefined,
				});
			}
		}
		return rawResults;
	}

	async lookup(text: string): Promise<LookupResult[]> {
		// 查两个库（Jitendex + JMnedict）的并集，合并去重 + 按 score 排序
		const [r1, r2] = await Promise.all([
			this.lookupInDb(this.db, text),
			this.lookupInDb(this.dbNames, text),
		]);
		const uniqueResults = new Map<string, LookupResult>();
		for (const match of [...r1, ...r2]) {
			const signature = `${match.expression}-${match.reading}-${JSON.stringify(
				match.glossary
			)}`;
			if (!uniqueResults.has(signature)) {
				uniqueResults.set(signature, match);
			}
		}
		return Array.from(uniqueResults.values()).sort((a, b) => b.score - a.score);
	}
}
