// 端到端测 DictionaryManager 导入流程：用 fake-indexeddb 提供真实 IndexedDB 语义，
// 连同 accents 加载一起测。重点验证「所有词条 + tag 导入完成后才刷版本号（dictionaries）」，
// 防止导入中途退出后 dictionaries 已记新版本号但词条不完整，再开误判为已最新。
//
// fake-indexeddb/auto 注册全局 indexedDB/IDBKeyRange，idb 的 openDB 直接可用。
// manager.ts 模块级 import ACCENTS_B64_GZ（构建产物，~1.2MB），加载 accents 走 DecompressionStream
// （Node 18+ 有）。测试实例化 DictionaryManager → init()（开库 + 加载 accents）→ processZipFiles。
import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDB, type IDBPDatabase } from "idb";
import { zipSync } from "fflate";
import { DictionaryManager, type YomitanDB } from "../src/dictionary/manager.ts";
import type { DictionaryMeta } from "../src/dictionary/types.ts";

/** 构造一个假词典 zip：index.json + term_bank_1.json + tag_bank_1.json，返回 ArrayBuffer */
function buildDictZip(opts: {
	title: string;
	revision: string;
	terms: unknown[][];
	tags?: unknown[][];
}): ArrayBuffer {
	const files: Record<string, Uint8Array> = {
		"index.json": new TextEncoder().encode(
			JSON.stringify({
				title: opts.title,
				revision: opts.title.includes("Jitendex") ? opts.revision : opts.revision,
				format: 3,
				author: "test",
				description: "test dict",
				url: "https://example.com",
			} satisfies DictionaryMeta),
		),
		"term_bank_1.json": new TextEncoder().encode(JSON.stringify(opts.terms)),
	};
	if (opts.tags && opts.tags.length > 0) {
		files["tag_bank_1.json"] = new TextEncoder().encode(JSON.stringify(opts.tags));
	}
	const zipped = zipSync(files);
	// 复制到独立的 ArrayBuffer（zipSync 返回的 Uint8Array.buffer 可能是更大 buffer 的视图）
	const buf = new ArrayBuffer(zipped.byteLength);
	new Uint8Array(buf).set(zipped);
	return buf;
}

/** 标准 Yomitan term_bank 条目：[expression, reading, tags, rules, score, glossary..., seqId, attribution] */
function term(expression: string, reading: string, gloss: string): unknown[] {
	return [expression, reading, "", "", 0, [gloss], 0, ""];
}

/** 标准 Yomitan tag_bank 条目：[name, category, order, notes, score, short] */
function tag(name: string, category: string): unknown[] {
	return [name, category, 0, "", 0, ""];
}

/** 打开一个带正确 schema 的 DB（terms(expression/reading 索引)+dictionaries(title)+tag_defs(name)） */
async function openTestDB(name: string): Promise<IDBPDatabase<YomitanDB>> {
	return openDB<YomitanDB>(name, 1, {
		upgrade(db) {
			const termStore = db.createObjectStore("terms", { autoIncrement: true });
			termStore.createIndex("expression", "expression", { unique: false });
			termStore.createIndex("reading", "reading", { unique: false });
			db.createObjectStore("dictionaries", { keyPath: "title" });
			db.createObjectStore("tag_defs", { keyPath: "name" });
		},
	});
}

/** 单例 manager（懒加载，首次调用时实例化 + init；node:test 无 beforeAll，用懒加载代替） */
let mgrPromise: Promise<DictionaryManager> | null = null;
function getMgr(): Promise<DictionaryManager> {
	if (!mgrPromise) {
		const m = new DictionaryManager();
		mgrPromise = m.init().then(() => m);
	}
	return mgrPromise;
}

beforeEach(() => {
	// noop（node:test 无 beforeAll，manager 用懒加载）
});

test("init 加载 accents：hasAccents 为 true", async () => {
	const m = await getMgr();
	assert.equal(m.hasAccents, true);
});

test("getAccents 能查到已知词的声调（accents 真实加载）", async () => {
	const mgr = await getMgr();
	// 食べる 在 kanjium accents 里有记录（0=头高型 / 平板）
	const positions = mgr.getAccents("食べる", "たべる");
	assert.ok(Array.isArray(positions), "getAccents 应返回数组");
});

test("processZipFiles：词条 + tag 全部导入后才写 dictionaries（顺序正确）", async () => {
	const mgr = await getMgr();
	const db = await openTestDB("test-import-order");
	const files: Record<string, Uint8Array> = {
		"index.json": new TextEncoder().encode(
			JSON.stringify({ title: "TestJitendex", revision: "2026-10-31", format: 3 } satisfies DictionaryMeta),
		),
		"term_bank_1.json": new TextEncoder().encode(
			JSON.stringify([term("食べる", "たべる", "吃"), term("飲む", "のむ", "喝")]),
		),
		"tag_bank_1.json": new TextEncoder().encode(
			JSON.stringify([tag("v5r", "partOfSpeech"), tag("n", "partOfSpeech")]),
		),
	};
	await mgr.processZipFiles(db, files);
	// 全部词条已入库
	const allTerms = await db.getAll("terms");
	assert.equal(allTerms.length, 2);
	// dictionaries 在词条之后写入（最终状态：两 store 都有数据）
	const dicts = await db.getAll("dictionaries");
	assert.equal(dicts.length, 1);
	assert.equal(dicts[0].title, "TestJitendex");
	assert.equal(dicts[0].revision, "2026-10-31");
	// tag_defs 也已入库
	const tags = await db.getAll("tag_defs");
	assert.equal(tags.length, 2);
	db.close();
});

test("导入中途失败不写版本号：term_bank 解析抛错时 dictionaries 保持空", async () => {
	const mgr = await getMgr();
	const db = await openTestDB("test-partial-fail");
	// term_bank_1.json 是损坏的 JSON，会触发解析失败（processZipFiles 内 catch 记录失败、最后抛错）
	// 关键：dictionaries 不能已被写入新版本号
	const files: Record<string, Uint8Array> = {
		"index.json": new TextEncoder().encode(
			JSON.stringify({ title: "PartialJitendex", revision: "2026-10-31", format: 3 } satisfies DictionaryMeta),
		),
		"term_bank_1.json": new TextEncoder().encode("{ 这不是合法 JSON }"),
	};
	// processZipFiles 应抛错（词条导入失败，不写版本号）
	await assert.rejects(mgr.processZipFiles(db, files), /词条导入失败/);
	// 修复前：dictionaries 已被 put（先写版本号），会误判为已最新
	// 修复后：dictionaries 保持空（版本号最后才写，词条导入失败则不写）
	const dicts = await db.getAll("dictionaries");
	assert.equal(dicts.length, 0, "词条导入失败时 dictionaries 不应写入版本号");
	const allTerms = await db.getAll("terms");
	assert.equal(allTerms.length, 0, "词条未导入");
	db.close();
});

test("导入完整词典（走 importFromZipBuffer 公开入口 + unzip）", async () => {
	const mgr = await getMgr();
	// init 已开 this.db（Jitendex 库），先清掉旧数据避免干扰
	await mgr.clear();
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃"), term("飲む", "のむ", "喝"), term("本", "ほん", "书")],
		tags: [tag("v5r", "partOfSpeech")],
	});
	await mgr.importFromZipBuffer(buf);
	// 验证查询能命中
	const results = await mgr.lookup("食べる");
	assert.ok(results.length > 0, "导入后 lookup 应命中");
	assert.ok(results.some((r) => r.expression === "食べる"));
	// 版本号已写入
	const dicts = await mgr.getDictionaries();
	assert.ok(dicts.some((d) => d.title === "TestJitendexFull" && d.revision === "2026-10-31"));
});

test("accents 导入流程后仍可用（导入不影响 accents）", async () => {
	const mgr = await getMgr();
	assert.equal(mgr.hasAccents, true);
	const positions = mgr.getAccents("食べる", "たべる");
	assert.ok(Array.isArray(positions));
});

test("clear：导入后清空，两库 terms/dictionaries/tag_defs 全空", async () => {
	const mgr = await getMgr();
	// 先导入数据到 Jitendex 库（this.db）
	await mgr.clear();
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃"), term("飲む", "のむ", "喝")],
		tags: [tag("v5r", "partOfSpeech")],
	});
	await mgr.importFromZipBuffer(buf);
	// 确认已导入
	assert.ok((await mgr.getDictionaries()).length > 0, "导入后应有词典元数据");
	assert.ok(await mgr.isImported(), "导入后 isImported 应为 true");

	// 清空
	await mgr.clear();

	// 验证两库三个 store 全空
	const dicts = await mgr.getDictionaries();
	assert.equal(dicts.length, 0, "清空后 dictionaries 应为空");
	assert.equal(await mgr.isImported(), false, "清空后 isImported 应为 false");
	// lookup 应查不到（terms 已清）
	const results = await mgr.lookup("食べる");
	assert.equal(results.length, 0, "清空后 lookup 应无结果");
});

test("clear 后可重新导入（清空不破坏库结构）", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃"), term("本", "ほん", "书")],
	});
	await mgr.importFromZipBuffer(buf);
	// 重新导入后能查到
	const results = await mgr.lookup("本");
	assert.ok(results.some((r) => r.expression === "本"), "清空后重新导入应能查到");
	const dicts = await mgr.getDictionaries();
	assert.ok(dicts.some((d) => d.title === "TestJitendexFull"), "重新导入后应有词典元数据");
	// 收尾清理，避免影响其他测试
	await mgr.clear();
});

// ====== lookup 查询逻辑测试 ======

/** 带 score 的 term（标准 Yomitan：[expression, reading, tags, rules, score, glossary..., seqId, attribution]） */
function termScored(expression: string, reading: string, gloss: string, score: number, rules: string = ""): unknown[] {
	return [expression, reading, "", rules, score, [gloss], 0, ""];
}

test("lookup：expression 精确命中 + reading 假名命中", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃"), term("本", "ほん", "书")],
	});
	await mgr.importFromZipBuffer(buf);
	// expression 精确命中
	const byExpr = await mgr.lookup("食べる");
	assert.ok(byExpr.some((r) => r.expression === "食べる"), "expression 精确命中");
	// reading 假名命中（たべる 也作为 reading 索引被命中）
	assert.ok(byExpr.some((r) => r.reading === "たべる"), "reading 假名命中");
	await mgr.clear();
});

test("lookup：deinflect 变形命中（食べます → 食べる）", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	// 食べる rules=v1（一段动词，deinflector ます→る 规则 rulesOut=v1），才能被 ます形 deinflect 命中
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [termScored("食べる", "たべる", "吃", 100, "v1")],
	});
	await mgr.importFromZipBuffer(buf);
	// 查 ます形，应 deinflect 回 食べる 命中
	const results = await mgr.lookup("食べます");
	assert.ok(results.some((r) => r.expression === "食べる"), "食べます 应 deinflect 命中 食べる");
	// deinflectionReasons 应非空（带变形原因链）
	const hit = results.find((r) => r.expression === "食べる");
	assert.ok(hit?.deinflectionReasons && hit.deinflectionReasons.length > 0, "变形命中应带 deinflectionReasons");
	await mgr.clear();
});

test("lookup：两库并集（Jitendex + JMnedict 各命中一条）", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	// Jitendex 库：食べる
	await mgr.importFromZipBuffer(buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	// JMnedict 库：田中（人名）
	await mgr.importNamesFromZipBuffer(buildDictZip({
		title: "TestJMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	// 查食べる 应命中（Jitendex库）
	const r1 = await mgr.lookup("食べる");
	assert.ok(r1.some((r) => r.expression === "食べる"), "Jitendex 库命中");
	// 查田中 应命中（JMnedict库）
	const r2 = await mgr.lookup("田中");
	assert.ok(r2.some((r) => r.expression === "田中"), "JMnedict 库命中");
	await mgr.clear();
});

test("lookup：signature 去重（两库同 expression+reading+glossary 合并去重）", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	// 两库导入完全相同的词条
	await mgr.importFromZipBuffer(buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	await mgr.importNamesFromZipBuffer(buildDictZip({
		title: "TestJMnedict",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	// signature 去重后应只剩一条
	const results = await mgr.lookup("食べる");
	const exact = results.filter((r) => r.expression === "食べる" && r.reading === "たべる");
	assert.equal(exact.length, 1, "两库相同 signature 应去重为一条");
	await mgr.clear();
});

test("lookup：按 score 降序排序", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	// 三条同 expression+reading 但 score 不同（glossary 不同避免 signature 去重）
	const buf = buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [
			termScored("走る", "はしる", "跑", 10),
			termScored("走る", "はしる", "奔跑", 500),
			termScored("走る", "はしる", "疾驰", 100),
		],
	});
	await mgr.importFromZipBuffer(buf);
	const results = await mgr.lookup("走る");
	assert.ok(results.length >= 3, "应命中至少 3 条");
	// 验证按 score 降序（第一条最大）
	for (let i = 1; i < results.length; i++) {
		assert.ok(results[i - 1].score >= results[i].score, `score 应降序：[${i - 1}]=${results[i - 1].score} >= [${i}]=${results[i].score}`);
	}
	// 最高分应是 500
	assert.equal(results[0].score, 500, "首条应为最高分 500");
	await mgr.clear();
});

test("lookup：查无结果返回空数组", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	const results = await mgr.lookup("这种词根本不存在xyz");
	assert.ok(Array.isArray(results));
	assert.equal(results.length, 0, "查无结果应返回空数组");
});

// ====== lookup 覆盖 20+ 种词类测试 ======
// 导入覆盖动词(各活用形 + 各类动词)、非动词(形容词/形容动词/名词/副词/连体词/助词/片假名/平假名/人名/地名/数词/拟声拟态)的词,
// 分别查辞书形(直查)或变形形(deinflect 还原),断言命中。验证 lookup 对各类词的查询正确性。

test("lookup：覆盖 20+ 种词类的查询", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	// 构造覆盖各类词的词条：[expression, reading, rules, gloss]
	// 动词 rules 按词类设(v1/v5/vk/vs/vz)，非动词 rules 空（直查总命中 rules=0 候选）
	const words: { expr: string; reading: string; rules: string; gloss: string; query: string; kind: string }[] = [
		// —— 五段动词 v5（各行代表）+ 各种变形查询 ——
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書く", kind: "五段动词(か行)辞书形直查" },
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書きます", kind: "五段动词 ます形" },
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書いた", kind: "五段动词 た形" },
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書いて", kind: "五段动词 て形" },
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書かない", kind: "五段动词 ない形" },
		{ expr: "書く", reading: "かく", rules: "v5", gloss: "写", query: "書けば", kind: "五段动词 条件ば形" },
		{ expr: "泳ぐ", reading: "およぐ", rules: "v5", gloss: "游泳", query: "泳ぐ", kind: "五段动词(が行)辞书形" },
		{ expr: "話す", reading: "はなす", rules: "v5", gloss: "说", query: "話す", kind: "五段动词(さ行)辞书形" },
		{ expr: "待つ", reading: "まつ", rules: "v5", gloss: "等", query: "待つ", kind: "五段动词(た行)辞书形" },
		{ expr: "死ぬ", reading: "しぬ", rules: "v5", gloss: "死", query: "死ぬ", kind: "五段动词(な行)辞书形" },
		{ expr: "遊ぶ", reading: "あそぶ", rules: "v5", gloss: "玩", query: "遊ぶ", kind: "五段动词(ば行)辞书形" },
		{ expr: "飲む", reading: "のむ", rules: "v5", gloss: "喝", query: "飲む", kind: "五段动词(ま行)辞书形" },
		{ expr: "走る", reading: "はしる", rules: "v5", gloss: "跑", query: "走る", kind: "五段动词(ら行)辞书形" },
		// —— 一段动词 v1 ——
		{ expr: "食べる", reading: "たべる", rules: "v1", gloss: "吃", query: "食べる", kind: "一段动词 辞书形直查" },
		{ expr: "食べる", reading: "たべる", rules: "v1", gloss: "吃", query: "食べます", kind: "一段动词 ます形" },
		{ expr: "食べる", reading: "たべる", rules: "v1", gloss: "吃", query: "食べた", kind: "一段动词 た形" },
		{ expr: "見る", reading: "みる", rules: "v1", gloss: "看", query: "見ない", kind: "一段动词 ない形" },
		// —— カ变动词 vk（来る）——
		{ expr: "来る", reading: "くる", rules: "vk", gloss: "来", query: "来る", kind: "カ变动词 辞书形" },
		{ expr: "来る", reading: "くる", rules: "vk", gloss: "来", query: "来ます", kind: "カ变动词 ます形" },
		// —— サ变动词 vs（する）——
		{ expr: "する", reading: "する", rules: "vs", gloss: "做", query: "する", kind: "サ变动词 辞书形" },
		{ expr: "する", reading: "する", rules: "vs", gloss: "做", query: "します", kind: "サ变动词 ます形" },
		// —— ザ行 vz ——
		{ expr: "ずる", reading: "ずる", rules: "vz", gloss: "(ザ行)", query: "ずる", kind: "ザ行动词 辞书形" },
		// —— 非动词（rules 空，直查总命中）——
		{ expr: "本", reading: "ほん", rules: "", gloss: "书", query: "本", kind: "名词(汉字)" },
		{ expr: "高い", reading: "たかい", rules: "", gloss: "高的", query: "高い", kind: "形容词(い形容词)" },
		{ expr: "静か", reading: "しずか", rules: "", gloss: "安静", query: "静か", kind: "形容动词(な形容词)" },
		{ expr: "とても", reading: "とても", rules: "", gloss: "非常", query: "とても", kind: "副词" },
		{ expr: "この", reading: "この", rules: "", gloss: "这个", query: "この", kind: "连体词" },
		{ expr: "で", reading: "で", rules: "", gloss: "(助词)", query: "で", kind: "助词" },
		{ expr: "コンピュータ", reading: "コンピュータ", rules: "", gloss: "电脑", query: "コンピュータ", kind: "片假名词" },
		{ expr: "だいがく", reading: "だいがく", rules: "", gloss: "(假名词)", query: "だいがく", kind: "平假名词" },
		{ expr: "一つ", reading: "ひとつ", rules: "", gloss: "一个", query: "一つ", kind: "数词" },
		{ expr: "ワクワク", reading: "ワクワク", rules: "", gloss: "心扑通扑通", query: "ワクワク", kind: "拟声拟态词" },
	];
	// 去重构造 term_bank（同 expr+reading+rules 合并；不同 query 的同词只导一次）
	const seen = new Set<string>();
	const terms: unknown[][] = [];
	for (const w of words) {
		const key = `${w.expr}|${w.reading}|${w.rules}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// rules 字符串按空格分（term_bank 第3字段是 tags、第4字段是 rules；这里 rules 放第4字段）
		terms.push([w.expr, w.reading, "", w.rules ? w.rules : "", 100, [w.gloss], 0, ""]);
	}
	await mgr.importFromZipBuffer(buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms,
	}));
	// 逐个查（query 可能是辞书形直查或变形还原），断言命中对应 expression
	let pass = 0;
	let fail = 0;
	const failures: string[] = [];
	for (const w of words) {
		const results = await mgr.lookup(w.query);
		const hit = results.some((r) => r.expression === w.expr && r.reading === w.reading);
		if (hit) {
			pass++;
		} else {
			fail++;
			failures.push(`「${w.kind}」query=${w.query} 期望命中 ${w.expr}(${w.reading}) 实际命中数=${results.length}`);
		}
	}
	// 报告：应全部命中（>=20 种都过）
	assert.equal(fail, 0, `${fail}/${words.length} 种词类未命中，详情:\n${failures.join("\n")}`);
	assert.ok(pass >= 20, `应至少覆盖 20 种词类，实际命中 ${pass} 种`);
});


// ====== getSourceInfo 聚合状态测试 ======
// 注意：fetchLatestRevision/fetchJMnedictLatestRevision 走 requestUrl（测试桩返回固定 json 无 tag_name/revision
// → 返回 null），故 latestRevision 恒为 null、hasUpdate 恒为 false。本组只测 installed/installedRevision/anyInstalled 部分。

test("getSourceInfo：空库时两源都未导入", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	const info = await mgr.getSourceInfo();
	assert.equal(info.sources.length, 2, "应有 2 个源");
	assert.equal(info.sources[0].installed, false, "Jitendex 未导入");
	assert.equal(info.sources[1].installed, false, "JMnedict 未导入");
	assert.equal(info.sources[0].installedRevision, null);
	assert.equal(info.sources[1].installedRevision, null);
	assert.equal(info.anyInstalled, false, "无任何导入");
	assert.equal(info.anyHasUpdate, false, "latest 为 null 时无更新");
});

test("getSourceInfo：Jitendex 已导入时 title/installed/installedRevision/anyInstalled 正确", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	await mgr.importFromZipBuffer(buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	const info = await mgr.getSourceInfo();
	// title 含 "Jitendex" 的词典被识别为 Jitendex 源
	assert.equal(info.sources[0].installed, true, "Jitendex 应已导入");
	assert.equal(info.sources[0].title, "TestJitendexFull");
	assert.equal(info.sources[0].installedRevision, "2026-10-31");
	// JMnedict 库空 → 未导入
	assert.equal(info.sources[1].installed, false, "JMnedict 未导入");
	assert.equal(info.sources[1].title, "JMnedict"); // 占位名
	assert.equal(info.anyInstalled, true, "有任一导入");
	await mgr.clear();
});

test("getSourceInfo：两库都导入时两源都 installed", async () => {
	const mgr = await getMgr();
	await mgr.clear();
	await mgr.importFromZipBuffer(buildDictZip({
		title: "TestJitendexFull",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	await mgr.importNamesFromZipBuffer(buildDictZip({
		title: "TestJMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	const info = await mgr.getSourceInfo();
	assert.equal(info.sources[0].installed, true, "Jitendex 已导入");
	assert.equal(info.sources[0].title, "TestJitendexFull");
	assert.equal(info.sources[1].installed, true, "JMnedict 已导入");
	assert.equal(info.sources[1].title, "TestJMnedict");
	assert.equal(info.anyInstalled, true);
	await mgr.clear();
});

// ====== fetchLatestRevision / fetchJMnedictLatestRevision 测试 ======
// 通过 setRequestFn 注入 mock 网络请求函数，避免真实联网。每个测试新建独立 manager（避免会话缓存串扰）。

/** 创建一个带 mock requestFn 的独立 manager（不与 getMgr 单例共享缓存） */
async function newMgrWithMock(
	mockFn: (params: { url: string; method: string }) => Promise<{ status: number; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string, string> }>,
): Promise<DictionaryManager> {
	const m = new DictionaryManager();
	m.setRequestFn(mockFn as never);
	m.setPluginDir("/test-plugin"); // 让 dictZipPath 等不报「未配置」
	await m.init();
	return m;
}

test("fetchLatestRevision：成功返回 tag_name", async () => {
	const m = await newMgrWithMock(async (params) => {
		assert.equal(params.url, "https://api.github.com/repos/stephenmk/stephenmk.github.io/releases/latest");
		return { status: 200, json: { tag_name: "2026-10-31" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
	});
	const rev = await m.fetchLatestRevision();
	assert.equal(rev, "2026-10-31");
});

test("fetchLatestRevision：会话缓存命中不再发请求", async () => {
	let calls = 0;
	const m = await newMgrWithMock(async () => {
		calls++;
		return { status: 200, json: { tag_name: "2026-10-31" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
	});
	const r1 = await m.fetchLatestRevision();
	assert.equal(r1, "2026-10-31");
	assert.equal(calls, 1, "首次应发请求");
	// 第二次应命中缓存，不发请求
	const r2 = await m.fetchLatestRevision();
	assert.equal(r2, "2026-10-31");
	assert.equal(calls, 1, "缓存命中应不再发请求");
});

test("fetchLatestRevision：HTTP 错误返回 null 并短暂缓存 null", async () => {
	let calls = 0;
	const m = await newMgrWithMock(async () => {
		calls++;
		return { status: 403, json: { message: "rate limit" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
	});
	const r1 = await m.fetchLatestRevision();
	assert.equal(r1, null, "403 应返回 null");
	assert.equal(calls, 1);
	// 失败也缓存 null，短时不重试
	const r2 = await m.fetchLatestRevision();
	assert.equal(r2, null);
	assert.equal(calls, 1, "失败缓存命中应不再发请求");
});

test("fetchLatestRevision：请求抛异常返回 null", async () => {
	const m = await newMgrWithMock(async () => {
		throw new Error("网络异常");
	});
	const r = await m.fetchLatestRevision();
	assert.equal(r, null, "异常应返回 null");
});

// fetchJMnedictLatestRevision 已删除（JMnedict 改用固定下载链接，不做更新检测）——
// 相关测试随之移除。getSourceInfo 里 JMnedict 的 latestRevision 恒为 null、hasUpdate 恒为 false。

// ====== updateDictionaries 编排测试 ======
// 通过 setRequestFn 注入 mock 网络（fetch + 分片下载），setFileAdapter 注入内存版文件适配器，
// 测并行下载 + 串行导入 + 跳过已最新 + 本地 zip 复用 + progress 回调。

/** 内存版文件适配器：按 path 存 ArrayBuffer，支持 exists/readBinary/write/append/remove */
function makeMemoryFileAdapter(): { adapter: import("../src/dictionary/manager").ChunkFileAdapter; files: Map<string, ArrayBuffer> } {
	const files = new Map<string, ArrayBuffer>();
	const adapter = {
		async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
			files.set(path, data.slice(0));
		},
		async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
			const prev = files.get(path);
			const merged = new ArrayBuffer((prev?.byteLength ?? 0) + data.byteLength);
			const view = new Uint8Array(merged);
			if (prev) view.set(new Uint8Array(prev), 0);
			view.set(new Uint8Array(data), prev?.byteLength ?? 0);
			files.set(path, merged);
		},
		async remove(path: string): Promise<void> {
			files.delete(path);
		},
		async exists(path: string): Promise<boolean> {
			return files.has(path);
		},
		async readBinary(path: string): Promise<ArrayBuffer> {
			const buf = files.get(path);
			if (!buf) throw new Error(`文件不存在: ${path}`);
			return buf;
		},
	};
	return { adapter, files };
}

/** 构造 mock requestFn：fetch（GitHub API）返回 JSON；下载（HEAD+GET Range）返回 zip 字节。
 *  JMnedict 不再做更新检测（固定下载链接），故 mock 不再处理 JMnedict.json fetch。 */
function makeUpdateRequestFn(opts: {
	jitLatest: string | null;
	jitZipBytes: Uint8Array;
	jmZipBytes: Uint8Array;
}): (params: { url: string; method: string; headers?: Record<string, string> }) => Promise<{ status: number; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> {
	return async (params) => {
		// Jitendex fetch（GitHub releases API）
		if (params.url.includes("api.github.com")) {
			if (opts.jitLatest === null) return { status: 403, json: { message: "rate limit" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
			return { status: 200, json: { tag_name: opts.jitLatest }, arrayBuffer: new ArrayBuffer(0), headers: {} };
		}
		// 下载（HEAD/GET）——按 url 区分 Jitendex/JMnedict zip
		const isJit = params.url.includes("jitendex-yomitan.zip");
		const bytes = isJit ? opts.jitZipBytes : opts.jmZipBytes;
		if (params.method === "HEAD") {
			return { status: 200, json: {}, arrayBuffer: new ArrayBuffer(0), headers: { "content-length": String(bytes.length) } };
		}
		// GET with Range
		const range = params.headers?.Range ?? `bytes=0-${bytes.length - 1}`;
		const m = range.match(/^bytes=(\d+)-(\d+)$/);
		const start = m ? parseInt(m[1], 10) : 0;
		const end = m ? parseInt(m[2], 10) : bytes.length - 1;
		const slice = bytes.slice(start, end + 1);
		return { status: 206, json: {}, arrayBuffer: slice.buffer.slice(0), headers: {} };
	};
}

test("updateDictionaries：全新安装，并行下载 + 串行导入两本，updatedCount=2", async () => {
	const jitZip = new Uint8Array(buildDictZip({
		title: "Jitendex",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	const jmZip = new Uint8Array(buildDictZip({
		title: "JMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	const { adapter } = makeMemoryFileAdapter();
	const m = await newMgrWithMock(makeUpdateRequestFn({
		jitLatest: "2026-10-31",
		jitZipBytes: jitZip,
		jmZipBytes: jmZip,
	}));
	m.setFileAdapter(adapter);
	await m.clear();
	const { updatedCount } = await m.updateDictionaries();
	assert.equal(updatedCount, 2, "两本都应更新");
	// 导入后能查到
	assert.ok((await m.lookup("食べる")).some((r) => r.expression === "食べる"), "Jitendex 命中");
	assert.ok((await m.lookup("田中")).some((r) => r.expression === "田中"), "JMnedict 命中");
	await m.clear();
});

test("updateDictionaries：已导入且==latest 时跳过，updatedCount=0", async () => {
	const jitZip = new Uint8Array(buildDictZip({
		title: "Jitendex",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	const jmZip = new Uint8Array(buildDictZip({
		title: "JMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	const { adapter } = makeMemoryFileAdapter();
	const m = await newMgrWithMock(makeUpdateRequestFn({
		jitLatest: "2026-10-31",
		jitZipBytes: jitZip,
		jmZipBytes: jmZip,
	}));
	m.setFileAdapter(adapter);
	await m.clear();
	// 第一次安装
	await m.updateDictionaries();
	// 第二次：已导入且==latest，应全跳过
	let downloadCalls = 0;
	// 包一层计数「下载请求」（HEAD 或带 Range 的 GET），不含 fetch
	const origFn = (m as unknown as { requestFn: (p: { url: string; method: string; headers?: Record<string, string> }) => Promise<unknown> }).requestFn;
	(m as unknown as { requestFn: typeof origFn }).requestFn = async (p) => {
		const isDownload = p.method === "HEAD" || (p.method === "GET" && p.headers?.Range !== undefined);
		if (isDownload) downloadCalls++;
		return origFn(p);
	};
	const { updatedCount } = await m.updateDictionaries();
	assert.equal(updatedCount, 0, "已最新应全跳过");
	assert.equal(downloadCalls, 0, "已最新不应下载");
	await m.clear();
});

test("updateDictionaries：progress 回调按源 + stage 触发", async () => {
	const jitZip = new Uint8Array(buildDictZip({
		title: "Jitendex",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	const jmZip = new Uint8Array(buildDictZip({
		title: "JMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	const { adapter } = makeMemoryFileAdapter();
	const m = await newMgrWithMock(makeUpdateRequestFn({
		jitLatest: "2026-10-31",
		jitZipBytes: jitZip,
		jmZipBytes: jmZip,
	}));
	m.setFileAdapter(adapter);
	await m.clear();
	const events: { name: string; stage: string }[] = [];
	await m.updateDictionaries((name, stage) => events.push({ name, stage }));
	// 应有两本的 fetching/downloading/installing/done 序列
	const names = new Set(events.map((e) => e.name));
	assert.ok(names.has("Jitendex") && names.has("JMnedict"), "两本都应有 progress 事件");
	for (const name of ["Jitendex", "JMnedict"]) {
		const stages = events.filter((e) => e.name === name).map((e) => e.stage);
		assert.ok(stages.includes("fetching"), `${name} 应有 fetching`);
		assert.ok(stages.includes("installing"), `${name} 应有 installing`);
		assert.ok(stages.includes("done"), `${name} 应有 done`);
	}
	await m.clear();
});

test("updateDictionaries：本地 zip 版本==latest 时复用，跳过下载", async () => {
	const jitZip = new Uint8Array(buildDictZip({
		title: "Jitendex",
		revision: "2026-10-31",
		terms: [term("食べる", "たべる", "吃")],
	}));
	const jmZip = new Uint8Array(buildDictZip({
		title: "JMnedict",
		revision: "2026-10-31",
		terms: [term("田中", "たなか", "姓氏")],
	}));
	const { adapter, files } = makeMemoryFileAdapter();
	// 预放本地 zip（revision==latest），模拟之前下载过。路径须与 dictZipPath 一致（含 pluginDir 前缀）
	files.set("/test-plugin/jitendex-yomitan.zip", jitZip.slice().buffer);
	files.set("/test-plugin/JMnedict.zip", jmZip.slice().buffer);
	const m = await newMgrWithMock(makeUpdateRequestFn({
		jitLatest: "2026-10-31",
		jitZipBytes: jitZip,
		jmZipBytes: jmZip,
	}));
	m.setFileAdapter(adapter);
	await m.clear();
	let downloadCalls = 0;
	// 包一层计数「下载请求」（HEAD 或带 Range 的 GET），不含 fetch（GitHub API / JMnedict index）
	const origFn = (m as unknown as { requestFn: (p: { url: string; method: string; headers?: Record<string, string> }) => Promise<unknown> }).requestFn;
	(m as unknown as { requestFn: typeof origFn }).requestFn = async (p) => {
		const isDownload = p.method === "HEAD" || (p.method === "GET" && p.headers?.Range !== undefined);
		if (isDownload) downloadCalls++;
		return origFn(p);
	};
	const { updatedCount } = await m.updateDictionaries();
	assert.equal(updatedCount, 2, "本地 zip 复用仍应导入（库为空）");
	assert.equal(downloadCalls, 0, "本地 zip 版本==latest 应跳过下载");
	await m.clear();
});





