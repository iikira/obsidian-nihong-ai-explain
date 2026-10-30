import { ButtonComponent, Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import type { DictSourceInfo } from "../dictionary/manager";
import { TagHelpModal } from "./tagHelpModal";
import { logWarn, logError, errMsg } from "../log";

/** 格式化多词典源信息为设置行描述文本 */
function formatDictDesc(info: DictSourceInfo): string {
	if (info.sources.length === 0) {
		return "获取词典源信息失败";
	}
	const parts = info.sources.map((s) => {
		const seg: string[] = [];
		if (s.installed) {
			seg.push(`${s.title}: 已导入 ${s.installedRevision ?? "(未知)"}`);
			if (s.latestRevision) {
				seg.push(s.hasUpdate ? `最新 ${s.latestRevision}（可更新）` : `已是最新`);
			} else {
				seg.push("最新版本获取失败");
			}
		} else {
			seg.push(`${s.title}: 未导入`);
			if (s.latestRevision) {
				seg.push(`最新 ${s.latestRevision}（可安装）`);
			} else {
				seg.push("点击右侧按钮安装");
			}
		}
		return seg.join(" ");
	});
	return parts.join("；");
}

/** 「离线词典」分组：一键安装/更新 Jitendex + JMnedict 两本词典（一个按钮）+ 清空词典。 */
export function renderOfflineDictSection(ctx: SettingsContext, body: HTMLElement): void {
	// 离线词典：一个按钮承担两本词典的安装/更新
	const s = new Setting(body).setName("离线词典").setDesc("检测中…");
	// 按钮引用：在 addButton 回调里赋值，供 refreshDictStatus 切换文案
	let dictBtn: ButtonComponent | null = null;

	/** 刷新词典行：desc 显示两本词典状态，按钮文案随是否有已导入切换 */
	const refreshDictStatus = async (): Promise<void> => {
		const mgr = ctx.plugin.dictionaryManager;
		if (!mgr || !mgr.isReady) {
			s.setDesc("词典未初始化");
			return;
		}
		let info: DictSourceInfo | null = null;
		try {
			info = await mgr.getSourceInfo();
		} catch (e) {
			s.setDesc("获取词典源信息失败");
			logWarn("settings", `获取词典源信息失败: ${errMsg(e)}`);
			return;
		}
		s.setDesc(formatDictDesc(info));
		// 任意一本已导入 → 「更新词典」；都未导入 → 「安装词典」
		dictBtn?.setButtonText(info.anyInstalled ? "更新词典" : "安装词典");
	};

	s.addButton((btn) => {
		dictBtn = btn;
		btn.setButtonText("安装词典")
			.setCta()
			.setTooltip("一键下载并导入 Jitendex + JMnedict 最新版（有更新则更新）")
			.onClick(async () => {
				const mgr = ctx.plugin.dictionaryManager;
				if (!mgr) {
					return;
				}
				const installing =
					btn.buttonEl.textContent?.includes("安装") ?? false;
				// 各阶段对应文案（带词典名）：更新到设置行描述
				const setStage = (dictName: string, stage: string): void => {
					const stageText: Record<string, string> = {
						fetching: "检测版本",
						downloading: "下载",
						installing: "安装",
						done: "完成",
					};
					s.setDesc(`${dictName}：${stageText[stage] ?? "处理"}中…`);
				};
				setStage("", "fetching");
				btn.setDisabled(true);
				try {
					const res = await mgr.updateDictionaries((dictName, stage) => {
						setStage(dictName, stage);
					});
					if (res.updatedCount > 0) {
						new Notice(
							`已${installing ? "安装" : "更新"} ${res.updatedCount} 本词典`,
							5000,
						);
					} else {
						new Notice("两本词典均已是最新版本");
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`${installing ? "安装" : "更新"}失败: ${msg}`, 8000);
					logError("settings", `词典更新失败: ${errMsg(e)}`);
				} finally {
					btn.setDisabled(false);
					await refreshDictStatus();
				}
			});
	});
	void refreshDictStatus();

	// 清空词典
	new Setting(body)
		.setName("清空词典")
		.setDesc("清空 IndexedDB 中的所有词典数据（Jitendex + JMnedict）。")
		.addButton((btn) =>
			btn
				.setButtonText("清空")
				.setDestructive()
				.onClick(async () => {
					const mgr = ctx.plugin.dictionaryManager;
					if (!mgr) {
						return;
					}
					await mgr.clear();
					new Notice("已清空词典");
					// 清空后刷新词典行（「更新词典」→「安装词典」），
					// 不整树重渲染（避免焦点跳到首个输入框触发文件夹下拉）
					await refreshDictStatus();
				}),
		);

	// 查看词典使用方法（Jitendex tag 说明）
	new Setting(body)
		.setName("词典使用方法")
		.setDesc("查看 Jitendex 词典查询结果中 tag（词性/用法标记）的中文解释。")
		.addButton((btn) =>
			btn
				.setButtonText("查看")
				.onClick(() => {
					new TagHelpModal(ctx.app).open();
				}),
		);
}
