/**
 * 缓存变更事件总线：翻译缓存 / 朗读缓存变更时通知订阅者。
 *
 * 日志面板的「翻译缓存」「朗读缓存」tab 不实时订阅缓存数据，而是按需重渲染；
 * 为避免手动点「刷新」，缓存写入/清空后通过此总线通知面板自动重渲染。
 * 解耦：缓存模块（translate/cache、tts/index）只调 emit，面板只 subscribe，互不感知。
 */

/** 缓存类型 */
export type CacheKind = "translate" | "tts";

type Listener = (kind: CacheKind) => void;

const listeners = new Set<Listener>();

/** 通知某类缓存已变更（缓存写入/清空后调用） */
export function emitCacheChange(kind: CacheKind): void {
	for (const cb of listeners) {
		cb(kind);
	}
}

/** 订阅缓存变更；返回取消订阅函数 */
export function subscribeCacheChange(cb: Listener): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}
