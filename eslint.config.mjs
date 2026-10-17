// eslint.config.mjs
// 采用 eslint-plugin-obsidianmd 的 recommended 配置（含 ESLint core、typescript-eslint
// type-checked、Obsidian 专属规则、第三方安全/导入规则）。
// recommended 含 type-checked 规则，需 projectService 让 typescript-eslint 找到 tsconfig；
// allowDefaultProject 兜底不在 tsconfig include（src/**/*.ts）范围的文件（配置/构建/测试脚本）。
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.*",
						"esbuild.config.*",
						"test/*.ts",
						"test/*.mjs",
					],
					// test/*.ts 与配置/构建脚本不在 tsconfig include 内，走 default project；
					// 数量略超默认上限 8，放宽到 16（仍可控，性能影响小）。
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
				},
			},
		},
	},
	{
		ignores: [
			"dist/**",
			"test-dist/**",
			"node_modules/**",
			".cache/**",
			"*.js.map",
			"src/dictionary/data/accentsData.ts",
			"src/tts/onecore/onecoreTtsB64.ts",
			"src/tts/onecore/onecore_tts.exe",
		],
	},
	{
		// 构建脚本（esbuild.config.mjs）在 Node 下运行（非插件代码、不上移动端），
		// 用 node:fs / node:https / node:zlib / process 是构建工具标准用法，豁免 no-nodejs-modules；
		// 用 Buffer 是 Node 全局，浏览器 globals 配置里没有，显式声明；
		// 构建进度用 console.log 输出是构建工具标准做法，豁免 no-console（obsidianmd 包装为 rule-custom-message）。
		files: ["esbuild.config.*"],
		languageOptions: {
			globals: { Buffer: "readonly" },
		},
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/rule-custom-message": "off",
			"no-undef": "off",
		},
	},
	{
		// 测试文件（走 default project，不在 tsconfig include 内）：
		// 用 node:test / node:assert 是 node 测试 runner 的标准用法，豁免 no-nodejs-modules；
		// test() 调用由 runner 处理返回值，豁免 no-floating-promises；
		// mock globalThis.window / 用 console 断言，豁免 no-global-this / no-console。
		// test/build.mjs 是测试构建脚本（用 node:fs / process / console），同属测试侧，一并豁免。
		files: ["test/*.ts", "test/*.mjs"],
		languageOptions: {
			globals: { process: "readonly" },
		},
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/rule-custom-message": "off",
			"@typescript-eslint/no-floating-promises": "off",
			"no-undef": "off",
		},
	},
	{
		// 全局规则覆盖：sentence-case 规则按英文大小写规范检查，对中文 UI 文案
		// （含 API/TTS/Edge 等英文词）误报多，关闭。
		rules: {
			"obsidianmd/ui/sentence-case": "off",
		},
	},
]);
