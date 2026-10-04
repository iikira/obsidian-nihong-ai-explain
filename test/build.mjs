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
const stubPlugin = {
	name: "stub-obsidian",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, (args) => ({
			path: args.path,
			namespace: "stub-obsidian",
		}));
		build.onLoad({ filter: /.*/, namespace: "stub-obsidian" }, () => ({
			contents: "module.exports = {};",
			loader: "js",
		}));
		build.onResolve({ filter: /^electron$/ }, (args) => ({
			path: args.path,
			namespace: "stub-obsidian",
		}));
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

