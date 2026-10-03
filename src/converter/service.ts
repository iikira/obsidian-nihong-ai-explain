import { Notice, normalizePath, type TFile, type Vault } from "obsidian";
import { convertEpub } from "./index";
import { ensureFolder } from "../utils";

export interface ConverterServiceOptions {
	/** 读取当前 vault */
	getVault: () => Vault;
	/** 占用/释放任务槽（沿用插件全局防重入） */
	tryStartTask: (actionId: string, key: string) => boolean;
	finishTask: (actionId: string, key: string) => void;
}

/** epub 转换服务：读 vault 二进制、调用纯函数转换、写 md/图片到输出目录。 */
export class ConverterService {
	private readonly opts: ConverterServiceOptions;

	constructor(opts: ConverterServiceOptions) {
		this.opts = opts;
	}

	onUnload(): void {
		// 无持久资源需清理
	}

	/** 把 vault 内一个 epub 文件转换为同层同名目录下的 md + images */
	async convert(file: TFile): Promise<void> {
		const path = file.path;
		if (!this.opts.tryStartTask("convert", path)) {
			new Notice(`「${file.name}」转换任务进行中`);
			return;
		}
		try {
			const vault = this.opts.getVault();
			const adapter = vault.adapter;

			// 1. 读 epub 二进制
			let buf: ArrayBuffer;
			try {
				buf = await adapter.readBinary(path);
			} catch (e) {
				this.fail("读取 epub 失败", e);
				return;
			}

			// 2. 纯函数转换
			let result;
			try {
				result = convertEpub(buf, file.basename);
			} catch (e) {
				this.fail("转换失败", e);
				return;
			}

			// 3. 计算输出目录：xxx.epub → 同层 xxx/
			const outDir = normalizePath(
				path.slice(0, path.length - file.extension.length - 1),
			);
			try {
				await ensureFolder(vault, outDir);
			} catch (e) {
				this.fail("创建输出目录失败", e);
				return;
			}

			// 4. 写章节 md（已存在则覆盖，幂等）
			for (const chapter of result.chapters) {
				const target = normalizePath(`${outDir}/${chapter.filename}`);
				await this.writeText(target, chapter.markdown);
			}

			// 5. 写图片到 outDir/images/
			const imageDir = normalizePath(`${outDir}/images`);
			if (result.images.length > 0) {
				await ensureFolder(vault, imageDir);
				for (const img of result.images) {
					const target = normalizePath(`${imageDir}/${img.filename}`);
					// 精确截取字节（unzipSync 返回的 Uint8Array 可能是更大 buffer 的视图）
					const data = img.bytes.buffer.slice(
						img.bytes.byteOffset,
						img.bytes.byteOffset + img.bytes.byteLength,
					) as ArrayBuffer;
					await this.writeBinary(target, data);
				}
			}

			const bookName = result.title || file.basename;
			new Notice(
				`「${bookName}」转换完成：${result.chapters.length} 章 / ${result.images.length} 张图`,
				6000,
			);
		} catch (e) {
			this.fail("写入输出文件失败", e);
		} finally {
			this.opts.finishTask("convert", path);
		}
	}

	/** 写文本文件：已存在则覆盖 */
	private async writeText(target: string, content: string): Promise<void> {
		const vault = this.opts.getVault();
		await vault.adapter.write(target, content);
	}

	/** 写二进制文件：已存在则覆盖 */
	private async writeBinary(target: string, data: ArrayBuffer): Promise<void> {
		const vault = this.opts.getVault();
		await vault.adapter.writeBinary(target, data);
	}

	private fail(prefix: string, e: unknown): void {
		const msg = e instanceof Error ? e.message : String(e);
		new Notice(`${prefix}: ${msg}`, 8000);
		console.error(`[nihong-ai-explain] ${prefix}:`, e);
	}
}
