import { Notice } from "obsidian";
import { logInfo } from "./log";

/**
 * 协作式取消：用于「AI 讲解」/「语法拆解」这类单次大模型生成任务的可取消进度通知。
 *
 * Obsidian 的 requestUrl 没有 abort 机制——一旦 HTTP 请求发出，无法真正取消底层网络请求。
 * 故「取消」是协作式：点取消后设标志，正在 await 的请求返回后丢弃结果、不写文件；
 * callChatCompletion 的重试循环在每次 attempt 之间检查标志，已取消则不再发起下一次重试。
 * 底层请求可能仍会跑完，但结果被忽略。
 */

/** 取消令牌：持有取消标志，供生成流程各 await 点检查 */
export interface CancelToken {
	/** 是否已取消 */
	cancelled: boolean;
}

/** 创建一个新的取消令牌 */
export function createCancelToken(): CancelToken {
	return { cancelled: false };
}

/**
 * 可取消的「正在生成…」进度通知：通知内嵌一个「取消」按钮，点击后置标志位并隐藏通知。
 * 返回 [notice, token]——notice 用于生成完成后手动 hide，token 供各 await 点检查。
 *
 * @param taskLabel 任务名（如 "explain" / "grammar"，即日志 source），仅作日志用
 */
export function showCancellableProgress(taskLabel: string): {
	notice: Notice;
	token: CancelToken;
} {
	const token = createCancelToken();
	// createFragment 是 Obsidian 全局函数（与 sleep 同属 obsidian.d.ts 的全局）
	const fragment = createFragment((f: DocumentFragment) => {
		f.createSpan({ text: "正在生成…" });
		const btn = f.createEl("button", {
			text: "取消",
			cls: "nihong-ai-cancel-btn",
		});
		btn.addEventListener("click", () => {
			token.cancelled = true;
			notice.setMessage("正在取消…");
			logInfo(taskLabel, "用户已取消生成");
		});
	});
	const notice = new Notice(fragment, 0);
	return { notice, token };
}

/**
 * 若已取消则抛 CancelledError，中断后续流程。在各 await 点（请求返回后、写文件前）调用。
 */
export class CancelledError extends Error {
	constructor() {
		super("已取消");
		this.name = "CancelledError";
	}
}

/** 检查取消标志，已取消则抛 CancelledError */
export function throwIfCancelled(token: CancelToken): void {
	if (token.cancelled) {
		throw new CancelledError();
	}
}
