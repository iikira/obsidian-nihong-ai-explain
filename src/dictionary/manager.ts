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

interface YomitanDB extends DBSchema {
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

/** Jitendex 安装/更新的阶段（供 UI 显示进度文案） */
export type JitendexStage =
	| "fetching"    // 拉取最新版本号 / 读取本地 zip 版本
	| "downloading" // 下载 zip（最慢，几十 MB）
	| "installing"  // 清空旧库 + 导入新数据
	| "done";       // 完成

/** 安装/更新进度回调：每个阶段切换时调用一次 */
export type JitendexProgressCb = (stage: JitendexStage) => void;

/** 分片下载的请求函数签名（与 obsidian 的 requestUrl 一致，抽出可注入以便测试 mock） */
export type ChunkRequestFn = (params: {
	url: string;
	method: string;
	headers?: Record<string, string>;
	throw?: boolean;
}) => Promise<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }>;

/** 分片下载的文件适配器（与 Obsidian DataAdapter 的写入/删除方法子集一致，可注入 mock） */
export interface ChunkFileAdapter {
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	appendBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
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

/** Jitendex 词典源元信息（供设置页展示与更新判断） */
export interface JitendexSourceInfo {
	/** 已导入词典的 revision（无导入则 null） */
	installedRevision: string | null;
	/** GitHub 最新 release tag_name（拉取失败则 null） */
	latestRevision: string | null;
	/** latestRevision 非空且与 installedRevision 不同 */
	hasUpdate: boolean;
	/** 已导入词典标题 */
	title: string | null;
}

export class DictionaryManager {
	private db: IDBPDatabase<YomitanDB> | null = null;
	private deinflector: Deinflector;
	private tagCache: Map<string, ProcessedTag> = new Map();
	private app: App | null = null;
	private pluginDir: string | null = null;
	private accentDb: AccentDb = new AccentDb();
	/** fetchLatestRevision 的会话内缓存值（null=未知或拉取失败）；命中缓存时不打 GitHub API */
	private latestRevisionCache: string | null = null;
	/** latestRevisionCache 的过期时间戳（ms）；过期后重新拉取。拉取失败则缩短缓存时间 */
	private latestRevisionCacheExpire = 0;
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

	async init(): Promise<void> {
		try {
			this.db = await openDB<YomitanDB>(DB_NAME, DB_VERSION, {
				upgrade(db) {
					const termStore = db.createObjectStore("terms", {
						autoIncrement: true,
					});
					termStore.createIndex("expression", "expression", {
						unique: false,
					});
					termStore.createIndex("reading", "reading", { unique: false });
					db.createObjectStore("dictionaries", { keyPath: "title" });
					db.createObjectStore("tag_defs", { keyPath: "name" });
				},
			});
			await this.loadTags();
			await this.loadAccents();
		} catch (e) {
			logError("dict", `IndexedDB 初始化失败: ${errMsg(e)}`);
		}
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
		if (!this.db) {
			return false;
		}
		try {
			const count = await this.db.count("dictionaries");
			return count > 0;
		} catch {
			return false;
		}
	}

	async getDictionaries(): Promise<DictionaryMeta[]> {
		if (!this.db) {
			return [];
		}
		return await this.db.getAll("dictionaries");
	}

	async clear(): Promise<void> {
		if (!this.db) {
			return;
		}
		await this.db.clear("terms");
		await this.db.clear("dictionaries");
		await this.db.clear("tag_defs");
		this.tagCache.clear();
	}

	/** 从插件目录扫描 zip 文件并导入（用户需先把 zip 复制到插件目录） */
	async importFromPluginDir(): Promise<void> {
		if (!this.db) {
			throw new Error("IndexedDB 未初始化");
		}
		if (!this.app) {
			throw new Error("App 未注入");
		}
		if (!this.pluginDir) {
			throw new Error("插件目录未配置");
		}
		const adapter = this.app.vault.adapter;
		const dir = normalizePath(this.pluginDir);
		// 列出插件目录下所有文件
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await adapter.list(dir);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`扫描插件目录失败: ${msg}`);
		}
		// adapter.list 返回的 files 已是完整 vault 相对路径（含目录前缀），直接用
		const zips = listed.files.filter((name) =>
			name.toLowerCase().endsWith(".zip"),
		);
		if (zips.length === 0) {
			throw new Error(
				`插件目录下未找到 zip 文件，请先将词典 zip 复制到: ${dir}`,
			);
		}
		if (zips.length > 1) {
			throw new Error(
				`插件目录下存在多个 zip 文件，请只保留一个: ${zips.join(", ")}`,
			);
		}
		const zipPath = zips[0];
		let buf: ArrayBuffer;
		try {
			buf = await adapter.readBinary(zipPath);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`读取 zip 失败: ${msg}`);
		}
		await this.importFromZipBuffer(buf);
	}

	/** 解压 zip 字节并导入 IndexedDB（供「从插件目录导入」与「下载导入」共用） */
	async importFromZipBuffer(buf: ArrayBuffer): Promise<void> {
		const files = unzipSync(new Uint8Array(buf));
		await this.processZipFiles(files);
	}

	/** Jitendex zip 在插件目录下的 vault 相对路径 */
	private jitendexZipPath(): string | null {
		if (!this.pluginDir) {
			return null;
		}
		return normalizePath(`${this.pluginDir}/${JITENDEX_ZIP_NAME}`);
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
	async downloadJitendexZip(): Promise<string> {
		if (!this.app || !this.pluginDir) {
			throw new Error("插件目录未配置，无法保存下载文件");
		}
		const adapter = this.app.vault.adapter;
		const zipPath = this.jitendexZipPath();
		if (!zipPath) {
			throw new Error("插件目录未配置");
		}
		await downloadChunked(requestUrl, adapter, JITENDEX_DOWNLOAD_URL, zipPath, {
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
			const resp = await requestUrl({
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

	/** 聚合已导入版本与最新版本信息（供设置页展示与更新判断） */
	async getSourceInfo(): Promise<JitendexSourceInfo> {
		let installedRevision: string | null = null;
		let title: string | null = null;
		try {
			const dicts = await this.getDictionaries();
			if (dicts.length > 0) {
				installedRevision = dicts[0].revision ?? null;
				title = dicts[0].title ?? null;
			}
		} catch {
			// 忽略，视为未导入
		}
		const latestRevision = await this.fetchLatestRevision();
		const hasUpdate =
			latestRevision !== null &&
			latestRevision !== installedRevision;
		return { installedRevision, latestRevision, hasUpdate, title };
	}

	/**
	 * 安装或更新到最新版：
	 * 1. 拉取最新版本号；若已导入版本与之一致则跳过（已是最新）
	 * 2. 若插件目录下的本地 zip 版本已与最新版一致，则跳过下载，直接用本地 zip 导入
	 * 3. 否则下载最新 zip 到插件目录（覆盖旧 zip）
	 * 4. 清空旧 IndexedDB 数据，导入新 zip
	 * 返回 { revision, updated }：updated=false 表示已是最新未变更，updated=true 表示重新导入完成
	 */
	async updateJitendex(
		onProgress?: JitendexProgressCb,
	): Promise<{ revision: string | null; updated: boolean }> {
		onProgress?.("fetching");
		const latest = await this.fetchLatestRevision();
		// 已导入版本与最新一致 → 跳过
		if (latest) {
			const installed = (await this.getDictionaries())[0]?.revision ?? null;
			if (installed && installed === latest) {
				return { revision: installed, updated: false };
			}
		}
		// 选择 zip 来源：本地 zip 版本与最新一致 → 复用，跳过下载；
		// 最新版本拉取失败但本地 zip 存在 → 退而用本地 zip（需校验版本不比已导入的低）；否则下载。
		let zipPath: string | null = this.jitendexZipPath();
		const localRev = await this.readLocalZipRevision();
		if (latest && localRev && localRev === latest) {
			// 本地 zip 版本与最新一致，跳过下载
		} else if (!latest && localRev) {
			// API 失败无法判断最新版，复用本地 zip 前先校验：本地 zip 版本不比已导入的低才装。
			const installed =
				(await this.getDictionaries())[0]?.revision ?? null;
			if (installed && compareRevisions(localRev, installed) <= 0) {
				return { revision: installed, updated: false };
			}
		} else {
			onProgress?.("downloading");
			zipPath = await this.downloadJitendexZip();
		}
		if (!zipPath) {
			throw new Error("无法获取词典 zip（插件目录未配置）");
		}
		onProgress?.("installing");
		await this.clear();
		const buf = await this.app!.vault.adapter.readBinary(zipPath);
		await this.importFromZipBuffer(buf);
		const dicts = await this.getDictionaries();
		onProgress?.("done");
		return { revision: dicts[0]?.revision ?? null, updated: true };
	}

	/** 读取插件目录下 jitendex-yomitan.zip 内 index.json 的 revision；无文件/解析失败返回 null */
	async readLocalZipRevision(): Promise<string | null> {
		if (!this.app || !this.pluginDir) {
			return null;
		}
		const adapter = this.app.vault.adapter;
		const zipPath = this.jitendexZipPath();
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

	private async processZipFiles(files: Record<string, Uint8Array>): Promise<void> {
		if (!this.db) {
			return;
		}
		new Notice("正在导入词典…", 3000);

		// 1. index.json
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
		await this.db.put("dictionaries", meta);

		// 2. term_bank_*.json
		const termKeys = Object.keys(files)
			.filter((k) => k.includes("term_bank_") && k.endsWith(".json"))
			.sort();
		let totalTerms = 0;
		for (const key of termKeys) {
			try {
				const txt = new TextDecoder().decode(files[key]);
				const rawTerms = JSON.parse(txt) as RawTermEntry[];
				const tx = this.db.transaction("terms", "readwrite");
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
				const tx = this.db.transaction("tag_defs", "readwrite");
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

		await this.loadTags();
		new Notice(`词典导入完成: ${totalTerms} 条`, 5000);
	}

	private async loadTags(): Promise<void> {
		if (!this.db) {
			return;
		}
		this.tagCache.clear();
		const tags = await this.db.getAll("tag_defs");
		for (const t of tags) {
			this.tagCache.set(t.name, t);
		}
	}

	getTag(name: string): ProcessedTag | undefined {
		return this.tagCache.get(name);
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

	async lookup(text: string): Promise<LookupResult[]> {
		if (!this.db) {
			return [];
		}
		const candidates = this.deinflector.deinflect(text);
		const uniqueResults = new Map<string, LookupResult>();

		for (const candidate of candidates) {
			const term = candidate.term;
			const expressionMatches = await this.db.getAllFromIndex(
				"terms",
				"expression",
				term
			);
			const readingMatches = await this.db.getAllFromIndex(
				"terms",
				"reading",
				term
			);
			const rawMatches = [...expressionMatches, ...readingMatches];
			for (const match of rawMatches) {
				if (!this.isValidDeinflection(candidate.rules, match.rules)) {
					continue;
				}
				const signature = `${match.expression}-${match.reading}-${JSON.stringify(
					match.glossary
				)}`;
				if (!uniqueResults.has(signature)) {
					uniqueResults.set(signature, {
						...match,
						deinflectionReasons:
							candidate.reasons.length > 0 ? candidate.reasons : undefined,
					});
				}
			}
		}
		return Array.from(uniqueResults.values()).sort((a, b) => b.score - a.score);
	}
}
