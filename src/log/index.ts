/**
 * 日志核心（纯逻辑，不依赖 DOM）：内存环形缓冲 + 订阅通知的日志单例。
 *
 * 各处诊断日志（TTS 调用、词典下载阶段、CallLogger token 统计、错误处理等）统一走
 * `logInfo/logWarn/logError`，由侧边栏日志页签（src/log/view.ts）订阅并实时渲染。
 * 替代直接 `console.*`（遵循 lint no-console，避免触发 obsidianmd/rule-custom-message）。
 *
 * 日志纯内存：上限 500 条，FIFO 弃旧；重启/重载后清空。不写 vault。
 */

/** 日志级别 */
export type LogLevel = "info" | "warn" | "error";

/** 单条日志记录 */
export interface LogEntry {
	/** 时间戳（ms，Date.now()） */
	ts: number;
	/** 级别 */
	level: LogLevel;
	/** 来源标签（如 "nihong-ai-explain"、"nihong-ai-explain tts"） */
	source: string;
	/** 日志文本（已格式化的字符串） */
	text: string;
}

/** 日志缓冲上限：超出按 FIFO 弃旧，避免内存无限增长 */
const MAX_ENTRIES = 500;

/** 订阅回调：新日志追加时触发，参数为最新一批（单条 append 时为单元素数组） */
type SubscribeCb = (entries: LogEntry[]) => void;

/**
 * 日志单例：内存数组 + 订阅通知。
 * 全局唯一实例（模块级），各处 import 共享同一缓冲。
 */
class Logger {
	private entries: LogEntry[] = [];
	private subscribers = new Set<SubscribeCb>();

	/** 追加一条日志，超上限弃旧，并通知订阅者 */
	log(level: LogLevel, source: string, text: string): void {
		const entry: LogEntry = { ts: Date.now(), level, source, text };
		this.entries.push(entry);
		while (this.entries.length > MAX_ENTRIES) {
			this.entries.shift();
		}
		this.notify([entry]);
	}

	/** 返回当前日志快照（只读副本，订阅者首次渲染用） */
	getEntries(): LogEntry[] {
		return this.entries.slice();
	}

	/** 清空全部日志，并通知订阅者 */
	clear(): void {
		this.entries = [];
		this.notify([]);
	}

	/** 订阅日志追加；返回取消订阅函数 */
	subscribe(cb: SubscribeCb): () => void {
		this.subscribers.add(cb);
		return () => {
			this.subscribers.delete(cb);
		};
	}

	private notify(batch: LogEntry[]): void {
		for (const cb of this.subscribers) {
			cb(batch);
		}
	}
}

/** 全局日志单例 */
export const logger = new Logger();

/** 便捷函数：info 级日志 */
export function logInfo(source: string, text: string): void {
	logger.log("info", source, text);
}

/** 便捷函数：warn 级日志 */
export function logWarn(source: string, text: string): void {
	logger.log("warn", source, text);
}

/** 便捷函数：error 级日志 */
export function logError(source: string, text: string): void {
	logger.log("error", source, text);
}

/** 把 Error/unknown 格式化为字符串（日志文本拼接用） */
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
