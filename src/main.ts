import { Notice, Plugin, TFile, normalizePath, requestUrl } from "obsidian";
import {
	DEFAULT_SETTINGS,
	NihongAIExplainSettings,
	NihongAIExplainSettingTab,
} from "./settings";
import { SelectionPill } from "./pill";

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface ChatChoice {
	message?: {
		content?: string;
		reasoning_content?: string;
		reasoning?: string;
	};
}

interface ChatCompletionResponse {
	choices?: ChatChoice[];
	error?: { message?: string };
}

const MAX_WORD_LEN = 100;
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/g;

export default class NihongAIExplainPlugin extends Plugin {
	settings!: NihongAIExplainSettings;
	private pill: SelectionPill | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new NihongAIExplainSettingTab(this.app, this));

		this.pill = new SelectionPill((text) => {
			void this.explain(text);
		});
		this.pill.attach();

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const sel = editor.getSelection().trim();
				if (!sel) {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle("AI 讲解此词")
						.setIcon("sparkles")
						.onClick(() => void this.explain(sel));
				});
			})
		);

		this.addCommand({
			id: "nihong-ai-explain-selection",
			name: "AI 讲解选中文字",
			callback: () => {
				const sel = window.getSelection()?.toString().trim() ?? "";
				if (!sel) {
					new Notice("请先选中一段文字");
					return;
				}
				void this.explain(sel);
			},
		});
	}

	onunload(): void {
		this.pill?.detach();
		this.pill = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		) as NihongAIExplainSettings;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private sanitizeFileName(word: string): string {
		return word
			.replace(FORBIDDEN_NAME_CHARS, "")
			.replace(/\s+/g, "_")
			.trim()
			.slice(0, MAX_WORD_LEN) || "untitled";
	}

	private resolveTargetPath(word: string): string {
		const fileName = `${this.sanitizeFileName(word)}.md`;
		const dir = (this.settings.outputDir ?? "").trim();
		if (!dir) {
			return normalizePath(fileName);
		}
		return normalizePath(`${dir}/${fileName}`);
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (!folder) {
			return;
		}
		const normalized = normalizePath(folder);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing) {
			return;
		}
		try {
			await this.app.vault.createFolder(normalized);
		} catch (e) {
			// 可能是并发创建，忽略
			const again = this.app.vault.getAbstractFileByPath(normalized);
			if (!again) {
				throw e;
			}
		}
	}

	private buildMessages(word: string): ChatMessage[] {
		const user = this.settings.userPromptTemplate.replace(/\{\{word\}\}/g, word);
		return [
			{ role: "system", content: this.settings.systemPrompt },
			{ role: "user", content: user },
		];
	}

	private async callModelOnce(
		messages: ChatMessage[]
	): Promise<string> {
		const url = `${this.settings.apiUrl.replace(/\/$/, "")}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.settings.apiKey) {
			headers["Authorization"] = `Bearer ${this.settings.apiKey}`;
		}
		const body = {
			model: this.settings.modelName,
			messages,
			temperature: this.settings.temperature,
			stream: false,
			reasoning_effort: "none",
		};
		const resp = await requestUrl({
			url,
			method: "POST",
			headers,
			body: JSON.stringify(body),
			throw: false,
		});
		const data = resp.json as ChatCompletionResponse;
		if (resp.status < 200 || resp.status >= 300) {
			const errMsg =
				data?.error?.message ||
				`HTTP ${resp.status}`;
			throw new Error(`API 请求失败: ${errMsg}`);
		}
		if (!data || !data.choices || data.choices.length === 0) {
			throw new Error("响应无 choices");
		}
		const msg = data.choices[0].message;
		const content = msg?.content ?? "";
		const reasoning = msg?.reasoning_content || msg?.reasoning || "";
		if (reasoning.trim()) {
			console.warn(
				`[nihong-ai-explain] reasoning_content 非空 (${reasoning.length} chars)，仍按 content 输出`
			);
		}
		if (!content.trim()) {
			throw new Error("响应 message.content 为空");
		}
		return content;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	private async callModelWithRetry(
		messages: ChatMessage[]
	): Promise<string> {
		const max = Math.max(0, this.settings.maxRetries);
		let lastErr: unknown = null;
		for (let attempt = 1; attempt <= max; attempt++) {
			try {
				return await this.callModelOnce(messages);
			} catch (e) {
				lastErr = e;
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(
					`[nihong-ai-explain] 第 ${attempt}/${max} 次失败: ${msg}`
				);
				if (attempt < max) {
					await this.sleep(this.settings.retryInterval);
				}
			}
		}
		const finalMsg =
			lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new Error(`重试 ${max} 次后仍失败: ${finalMsg}`);
	}

	async explain(word: string): Promise<void> {
		const clean = word.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (clean.length > MAX_WORD_LEN) {
			new Notice(`选区过长（${clean.length} 字符），已截断使用前 ${MAX_WORD_LEN} 字符`);
		}

		const targetPath = this.resolveTargetPath(clean);
		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			new Notice(`已存在，跳过: ${targetPath}`);
			return;
		}

		new Notice("正在生成…");
		const messages = this.buildMessages(clean);
		let content: string;
		try {
			content = await this.callModelWithRetry(messages);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`生成失败: ${msg}`, 8000);
			console.error("[nihong-ai-explain] 生成失败:", e);
			return;
		}

		const dir = (this.settings.outputDir ?? "").trim();
		try {
			if (dir) {
				await this.ensureFolder(dir);
			}
			await this.app.vault.create(targetPath, content);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`写入文件失败: ${msg}`, 8000);
			console.error("[nihong-ai-explain] 写入失败:", e);
			return;
		}

		new Notice(`已生成: ${targetPath}`);
	}
}
