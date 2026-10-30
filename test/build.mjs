// esbuild 把 test/*.test.ts 编译为 test-dist/*.test.cjs，供 node --test 运行。
// 用项目已有 esbuild，零新依赖。platform=node / format=cjs / bundle src 依赖。
import esbuild from "esbuild";
import { readdirSync, rmSync, mkdirSync } from "node:fs";

const SRC_DIR = "test";
const OUT_DIR = "test-dist";

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const testFiles = readdirSync(SRC_DIR)
	.filter((f) => f.endsWith(".test.ts"))
	.map((f) => `${SRC_DIR}/${f}`);

if (testFiles.length === 0) {
	console.log("[test] 未找到 test/*.test.ts");
	process.exit(0);
}

// 桩：obsidian / electron 在 Node 测试环境不存在，置空模块避免 require 失败。
// 待测函数都是纯函数，不实际调用 Obsidian API；若误用会在测试中抛错（被测试捕获）。
//
// 另：tts/index.ts 经 windows.ts 引入 onecoreTtsB64.ts（构建时生成、gitignore 不提交）。
// 干净 checkout 下跑 test 不会先生成 onecoreTtsB64.ts，直接 bundle 会失败。故对以下模块也置桩：
//   - onecoreTtsB64（构建产物，可能不存在）
//   - src/tts/windows（依赖 window.require/child_process，测试环境无意义）
// 用 path 正则匹配 onResolve（esbuild 解析后的路径），重定向到 stub-stub 命名空间。
const stubModules = [
	// filter 匹配 esbuild onResolve 的 path：
	//   - 相对说明符（./windows、./onecore/onecoreTtsB64）此时尚未加扩展名
	// esbuild 在插件 onResolve 返回 path 后才解析，故 args.path 是说明符原样。
	{ filter: /(^|\/)windows$/, contents: "module.exports = { synthesizeWindows: async () => new ArrayBuffer(0), isWindowsTTSAvailable: () => false, listWindowsVoices: async () => [], probeWindowsTTSOnce: async () => false };" },
	{ filter: /(^|\/)onecoreTtsB64$/, contents: "module.exports = { ONECORE_TTS_B64: '' };" },
];

const stubPlugin = {
	name: "stub-obsidian",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, (args) => ({
			path: args.path,
			namespace: "stub-obsidian",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
			// 导出最小桩：speakText/各模块用到的 Notice（类）、requestUrl 等；
			// 测试不应真实触网，requestUrl 在测试中通过缓存命中绕开
			contents: "module.exports = { Notice: function Notice() {}, requestUrl: async () => ({ status: 200, json: { data: [] }, arrayBuffer: new ArrayBuffer(0) }) };",
			loader: "js",
		}));
		build.onResolve({ filter: /^electron$/ }, (args) => ({
			path: args.path,
			namespace: "stub-obsidian",
		}));
		// 其余置桩模块：重定向到独立命名空间，onLoad 按 path 匹配返回对应内容
		for (const mod of stubModules) {
			build.onResolve({ filter: mod.filter }, (args) => ({
				path: args.path,
				namespace: "stub-modules",
			}));
		}
		build.onLoad({ filter: /.*/, namespace: "stub-modules" }, (args) => {
			const mod = stubModules.find((m) => m.filter.test(args.path));
			return { contents: mod ? mod.contents : "module.exports = {};", loader: "js" };
		});
	},
};

for (const file of testFiles) {
	const out = `${OUT_DIR}/${file.slice(SRC_DIR.length + 1, -3)}.test.cjs`;
	await esbuild.build({
		entryPoints: [file],
		outfile: out,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "es2018",
		sourcemap: "inline",
		logLevel: "warning",
		plugins: [stubPlugin],
		// Node 内置模块保持 external，避免 esbuild 去掉 node: 前缀导致 require("test") 找不到
		external: ["node:*"],
	});
	console.log(`[test] 编译 ${file} -> ${out}`);
}

