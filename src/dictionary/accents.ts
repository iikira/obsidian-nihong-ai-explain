/**
 * 声调（pitch accent）索引：直接读取 kanjium accents.txt（TSV）。
 *
 * 文件格式：`expression<TAB>reading<TAB>positions`
 * - positions 多为单个数字（如 `0`、`4`），表示声调核位置
 * - 也可能是逗号分隔的多个数字（如 `4,0`），表示该词有多种声调型
 * - 少数带词性标注（如 `(副)0,(名)3`），表示不同词性下声调不同
 *   —— 这里剥离词性，把所有可能位置合并去重作为候选
 *
 * 位置语义：0 = 平板型（平板），1 = 头高型，n = 中高型（第 n 拍之后下降）。
 */
export class AccentDb {
	/** key = `${expression}\t${reading}` → 候选声调位置列表（去重） */
	private readonly index = new Map<string, number[]>();

	/** 解析 accents.txt 全文，构建内存索引 */
	load(text: string): void {
		this.index.clear();
		const lines = text.split(/\r?\n/);
		for (const line of lines) {
			if (!line) {
				continue;
			}
			const parts = line.split("\t");
			if (parts.length < 3) {
				continue;
			}
			const expression = parts[0];
			const reading = parts[1];
			const positions = this.parsePositions(parts[2]);
			if (positions.length === 0) {
				continue;
			}
			// 同 expression+reading 多行：合并去重
			const key = `${expression}\t${reading}`;
			const existing = this.index.get(key);
			if (existing) {
				for (const p of positions) {
					if (!existing.includes(p)) {
						existing.push(p);
					}
				}
			} else {
				this.index.set(key, positions);
			}
		}
	}

	/** 解析第 3 列：剥离词性标注，收集所有声调位置（去重） */
	private parsePositions(raw: string): number[] {
		const result: number[] = [];
		// 按 `,` 分割，每段形如 `(副)0` 或 `0`，剥离前缀词性标记
		for (const seg of raw.split(",")) {
			const m = seg.match(/-?\d+/);
			if (!m) {
				continue;
			}
			const n = Number(m[0]);
			if (Number.isFinite(n) && !result.includes(n)) {
				result.push(n);
			}
		}
		return result;
	}

	/** 是否已加载声调数据 */
	get isLoaded(): boolean {
		return this.index.size > 0;
	}

	/**
	 * 查询某 expression+reading 的候选声调位置。
	 * 先精确匹配 expression+reading；找不到则尝试仅按 reading 匹配（纯假名词典形）。
	 * 返回候选位置列表（可能为空）。
	 */
	lookup(expression: string, reading: string): number[] {
		const exact = this.index.get(`${expression}\t${reading}`);
		if (exact) {
			return exact;
		}
		// 纯假名词：expression === reading，按 reading 兜底查一次
		if (expression === reading) {
			for (const [key, positions] of this.index) {
				const [e, r] = key.split("\t");
				if (r === reading && (!e || e === reading)) {
					return positions;
				}
			}
		}
		return [];
	}
}
