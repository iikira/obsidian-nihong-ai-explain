import { ButtonComponent, Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import type { JitendexSourceInfo } from "../dictionary/manager";

/** 格式化 Jitendex 源信息为设置行描述文本 */
function formatJitendexDesc(
	info: JitendexSourceInfo | null,
	forceLatest: boolean,
): string {
	if (!info) {
		return "获取词典源信息失败";
	}
	const parts: string[] = [];
	if (info.installedRevision) {
		parts.push(`已导入: ${info.installedRevision}`);
	} else {
		parts.push("未导入");
	}
	if (info.latestRevision) {
		if (info.hasUpdate) {
			parts.push(`最新: ${info.latestRevision}（可更新）`);
		} else {
			parts.push(`最新: ${info.latestRevision}（已是最新）`);
		}
	} else if (forceLatest) {
		parts.push("最新版本获取失败");
	} else {
		parts.push("点击右侧按钮安装/更新");
	}
	return parts.join("；");
}

/** 「离线词典」分组：Jitendex 词典安装/更新（按钮承担安装与更新）+ 清空词典。 */
export function renderOfflineDictSection(ctx: SettingsContext, body: HTMLElement): void {
	// Jitendex 词典：一个按钮承担安装/更新（首次使用=安装，已安装=更新）
	{
		const s = new Setting(body).setName("Jitendex 词典").setDesc("检测中…");
		// 按钮引用：在 addButton 回调里赋值，供 refreshDictStatus 切换文案
		let jitendexBtn: ButtonComponent | null = null;

		/** 刷新 Jitendex 行：desc 显示已导入/最新版本，按钮文案随是否已安装切换 */
		const refreshDictStatus = async (forceLatest = false): Promise<void> => {
			const mgr = ctx.plugin.dictionaryManager;
			if (!mgr || !mgr.isReady) {
				s.setDesc("词典未初始化");
				return;
			}
			let info: JitendexSourceInfo | null = null;
			try {
				info = await mgr.getSourceInfo();
			} catch (e) {
				s.setDesc("获取词典源信息失败");
				console.warn("[nihong-ai] 获取 Jitendex 源信息失败:", e);
				return;
			}
			s.setDesc(formatJitendexDesc(info, forceLatest));
			// 已导入 → 「更新词典」；未导入 → 「安装词典」
			jitendexBtn?.setButtonText(
				info.installedRevision ? "更新词典" : "安装词典",
			);
		};

		s.addButton((btn) => {
			jitendexBtn = btn;
			btn.setButtonText("安装词典")
				.setCta()
				.setTooltip("从 Jitendex 官方源下载并导入最新版")
				.onClick(async () => {
					const mgr = ctx.plugin.dictionaryManager;
					if (!mgr) {
						return;
					}
					const installing =
						btn.buttonEl.textContent?.includes("安装") ?? false;
					// 各阶段对应的文案：更新到设置行描述（描述行更宽，
					// 状态文本不会被截断；按钮在禁用态下文本显示不出来，故不更新按钮）
					const stageText: Record<string, string> = {
						fetching: "检测版本中…",
						downloading: "下载词典中…",
						installing: "安装词典中…",
						done: "完成",
					};
					const setStage = (stage: string): void => {
						s.setDesc(stageText[stage] ?? "处理中…");
					};
					setStage("fetching");
					btn.setDisabled(true);
					try {
						const res = await mgr.updateJitendex((stage) => {
							setStage(stage);
						});
						if (res.updated) {
							new Notice(
								`已${installing ? "安装" : "更新"}到 ${res.revision ?? "(未知版本)"}`,
								5000,
							);
						} else {
							new Notice(`已是最新版本: ${res.revision ?? "(未知)"}`);
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`${installing ? "安装" : "更新"}失败: ${msg}`, 8000);
						console.error("[nihong-ai] Jitendex 更新失败:", e);
					} finally {
						btn.setDisabled(false);
						await refreshDictStatus();
					}
				});
		});
		void refreshDictStatus();
	}

	// 清空词典
	new Setting(body)
		.setName("清空词典")
		.setDesc("清空 IndexedDB 中的所有词典数据。")
		.addButton((btn) =>
			btn
				.setButtonText("清空")
				.setWarning()
				.onClick(async () => {
					const mgr = ctx.plugin.dictionaryManager;
					if (!mgr) {
						return;
					}
					await mgr.clear();
					new Notice("已清空词典");
					ctx.update();
				}),
		);
}
