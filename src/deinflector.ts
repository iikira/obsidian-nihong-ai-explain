import { DEINFLECT_DATA } from "./data/deinflectData";
import type { DeinflectionResult } from "./types";

const RULE_TYPES = new Map<string, number>([
	["v1", 0b00000001], // 一段动词
	["v5", 0b00000010], // 五段动词
	["vs", 0b00000100], // サ变动词
	["vk", 0b00001000], // 力变动词
	["vz", 0b00010000], // ズ变动词
	["adj-i", 0b00100000], // 形容词
	["iru", 0b01000000], // 中间 -iru 词尾
]);

type NormalizedVariant = [string, string, number, number];
type NormalizedReason = [string, NormalizedVariant[]];

/**
 * 日语动词/形容词变形还原。
 *
 * 算法移植自 Yomichan（GPLv3），用 BFS 候选列表 + 位掩码规则匹配：
 * 1. 从原始词出发，对每条变形规则检查词尾是否匹配
 * 2. 匹配则替换词尾，记录变形原因，加入候选列表
 * 3. 对新候选继续应用规则，直到无规则可应用
 * 4. 返回所有候选（含原词），每个候选带累积的变形原因链
 */
export class Deinflector {
	private reasons: NormalizedReason[] = [];

	constructor() {
		this.reasons = this.normalizeReasons(DEINFLECT_DATA);
	}

	private normalizeReasons(data: typeof DEINFLECT_DATA): NormalizedReason[] {
		const result: NormalizedReason[] = [];
		for (const [reason, variants] of Object.entries(data)) {
			const normalized: NormalizedVariant[] = [];
			for (const v of variants) {
				const rulesInMask = this.rulesToMask(v.rulesIn);
				const rulesOutMask = this.rulesToMask(v.rulesOut);
				normalized.push([v.kanaIn, v.kanaOut, rulesInMask, rulesOutMask]);
			}
			result.push([reason, normalized]);
		}
		return result;
	}

	private rulesToMask(rules: string[]): number {
		let mask = 0;
		for (const r of rules) {
			const flag = RULE_TYPES.get(r);
			if (flag !== undefined) {
				mask |= flag;
			}
		}
		return mask;
	}

	getRuleFlags(rules: string[]): number {
		return this.rulesToMask(rules);
	}

	deinflect(source: string): DeinflectionResult[] {
		const results: DeinflectionResult[] = [
			{ term: source, rules: 0, reasons: [] },
		];
		for (let i = 0; i < results.length; ++i) {
			const { rules, term, reasons } = results[i];
			for (const [reason, variants] of this.reasons) {
				for (const [kanaIn, kanaOut, rulesInMask, rulesOutMask] of variants) {
					if (rules !== 0 && (rules & rulesInMask) === 0) {
						continue;
					}
					if (!term.endsWith(kanaIn)) {
						continue;
					}
					const newTerm = term.substring(0, term.length - kanaIn.length) + kanaOut;
					if (newTerm.length === 0) {
						continue;
					}
					results.push({
						term: newTerm,
						rules: rulesOutMask,
						reasons: [reason, ...reasons],
					});
				}
			}
		}
		return results;
	}
}
