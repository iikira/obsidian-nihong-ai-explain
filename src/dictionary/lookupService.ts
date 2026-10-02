import { Notice } from "obsidian";
import { centerRect } from "../popupUtils";
import { DictionaryManager } from "./manager";
import { DictionaryPopup } from "./popup";

export interface LookupServiceOptions {
	/** 获取词典管理器（未初始化时返回 null） */
	getManager: () => DictionaryManager | null;
	/** 读取词典卡片字号 */
	getDictFontSize: () => number;
	/** 占用/释放任务槽（沿用插件全局防重入） */
	tryStartTask: (actionId: string, text: string) => boolean;
	finishTask: (actionId: string, text: string) => void;
	/** 读取当前选区位置 */
	getSelectionRect: () => DOMRect | null;
}

/** 查词典服务：封装离线词典查询、词典卡片展示与交叉引用重查。 */
export class LookupService {
	private readonly opts: LookupServiceOptions;
	private popup: DictionaryPopup | null = null;

	constructor(opts: LookupServiceOptions) {
		this.opts = opts;
	}

	onUnload(): void {
		this.popup?.hide();
		this.popup = null;
	}

	async lookup(text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) {
			new Notice("选区为空");
			return;
		}
		if (!this.opts.tryStartTask("lookup", clean)) {
			new Notice(`「${clean}」词典查询任务进行中`);
			return;
		}
		try {
			const manager = this.opts.getManager();
			if (!manager || !manager.isReady) {
				new Notice("词典未初始化，请先在设置中导入词典");
				return;
			}
			const imported = await manager.isImported();
			if (!imported) {
				new Notice("未导入词典，请先在设置中导入");
				return;
			}
			if (!this.popup) {
				this.popup = new DictionaryPopup(
					(name) => manager.getTag(name),
					(query) => this.lookupInPopup(query),
					() => this.opts.getDictFontSize(),
				);
			}

			const rect = this.opts.getSelectionRect() ?? centerRect();
			this.popup.showLoading(rect);

			try {
				const results = await manager.lookup(clean);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.popup.showResult(results, rectNow);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const rectNow = this.opts.getSelectionRect() ?? rect;
				this.popup.showError(`查询失败: ${msg}`, rectNow);
				console.error("[nihong-ai-explain] 词典查询失败:", e);
			}
		} finally {
			this.opts.finishTask("lookup", clean);
		}
	}

	/** 卡片内交叉引用点击触发的重新查询，复用卡片当前位置而非选区 */
	private async lookupInPopup(query: string): Promise<void> {
		const clean = query.trim();
		if (!clean) {
			return;
		}
		const manager = this.opts.getManager();
		if (!manager || !this.popup) {
			return;
		}
		const rect = this.popup.getRect() ?? centerRect();
		this.popup.showLoading(rect);
		try {
			const results = await manager.lookup(clean);
			this.popup.showResult(results, rect);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.popup.showError(`查询失败: ${msg}`, rect);
			console.error("[nihong-ai-explain] 词典交叉引用查询失败:", e);
		}
	}
}
