import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { unzipSync } from "fflate";
import { Notice } from "obsidian";
import { Deinflector } from "./deinflector";
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

export class DictionaryManager {
	private db: IDBPDatabase<YomitanDB> | null = null;
	private deinflector: Deinflector;
	private tagCache: Map<string, ProcessedTag> = new Map();
	private pluginDir: string | null = null;

	constructor() {
		this.deinflector = new Deinflector();
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
		} catch (e) {
			console.error("[nihong-ai] IndexedDB 初始化失败:", e);
		}
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
		if (!this.pluginDir) {
			throw new Error("插件目录未配置");
		}
		let fs: typeof import("node:fs");
		let pathMod: typeof import("node:path");
		try {
			fs = require("node:fs");
			pathMod = require("node:path");
		} catch (_e) {
			throw new Error("当前平台不支持读取本地文件（需桌面端）");
		}
		let zipPath: string | null = null;
		try {
			const entries = fs.readdirSync(this.pluginDir);
			const zips = entries
				.filter((f) => f.toLowerCase().endsWith(".zip"))
				.map((f) => pathMod.join(this.pluginDir!, f));
			if (zips.length === 0) {
				throw new Error(
					`插件目录下未找到 zip 文件，请先将词典 zip 复制到: ${this.pluginDir}`,
				);
			}
			if (zips.length > 1) {
				throw new Error(
					`插件目录下存在多个 zip 文件，请只保留一个: ${zips.join(", ")}`,
				);
			}
			zipPath = zips[0];
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`扫描插件目录失败: ${msg}`);
		}
		try {
			const buf = fs.readFileSync(zipPath);
			const files = unzipSync(new Uint8Array(buf));
			await this.processZipFiles(files);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`读取 zip 失败: ${msg}`);
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
				throw new Error(`解析 index.json 失败: ${e}`);
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
				console.warn(`[nihong-ai] 解析 ${key} 失败:`, e);
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
				console.warn(`[nihong-ai] 解析 ${key} 失败:`, e);
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
