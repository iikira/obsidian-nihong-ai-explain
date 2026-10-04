/**
 * 词典参考文本渲染：纯函数，不依赖 Obsidian/DOM/网络，便于单元测试。
 * 从 src/explain/service.ts 抽出。
 */

/** 把声调核位置数字转成圆圈数字标记（⓪①②…），与词典弹窗一致 */
export function toAccentCircle(position: number): string {
	if (position === 0) {
		return "⓪";
	}
	if (position >= 1 && position <= 20) {
		return String.fromCodePoint(0x2460 + (position - 1));
	}
	return `(${position})`;
}

/**
 * 把一条 Yomitan 词条的 glossary（结构化内容）渲染成参考文本行（已含缩进）。
 * 针对 Jitendex 结构（也兼容标准 Yomitan 纯文本 glossary）：
 *   sense-groups（ul/li）→ 每个 sense-group 内的词性标签（part-of-speech-info /
 *   misc-info 的 span）单独一行；每个 sense（带 listStyleType 序号 ①②③ 或按序兜底）
 *   一行，后接该 sense 的 glossary li 释义（分号分隔）；example-sentence 块的日文
 *   （去 ruby 假名与空格）与译文各一行。
 * attribution / example-keyword 等来源/标记节点丢弃。
 */
export function renderTermEntry(glossary: unknown): string[] {
	const lines: string[] = [];

	/** 取节点 data.content 标记 */
	const dataContent = (n: Record<string, unknown>): string => {
		const d = n.data as Record<string, unknown> | undefined;
		return d && typeof d.content === "string" ? d.content : "";
	};

	/** 取节点 style.listStyleType（形如 "①"）作为序号 */
	const listMarker = (n: Record<string, unknown>): string => {
		const s = n.style as Record<string, unknown> | undefined;
		const v = s && typeof s.listStyleType === "string" ? s.listStyleType : "";
		// 去掉包裹引号，如 "\"①\"" → "①"
		return v.replace(/^"|"$/g, "").trim();
	};

	/** 把节点子树里的纯文本拼起来（ruby 只留 base，去 rt；去多余空格；跳过脚注） */
	const textOf = (node: unknown): string => {
		const parts: string[] = [];
		const walk = (n: unknown): void => {
			if (n == null) {
				return;
			}
			if (typeof n === "string") {
				parts.push(n);
				return;
			}
			if (Array.isArray(n)) {
				for (const c of n) {
					walk(c);
				}
				return;
			}
			if (typeof n !== "object") {
				return;
			}
			const o = n as Record<string, unknown>;
			// rt（振假名）整支丢弃
			if (o.tag === "rt") {
				return;
			}
			// 来源脚注（attribution-footnote，如译文末尾的 [1]）跳过
			if (dataContent(o) === "attribution-footnote") {
				return;
			}
			if (typeof o.text === "string") {
				parts.push(o.text);
				return;
			}
			if (o.content !== undefined) {
				walk(o.content);
				return;
			}
			if (Array.isArray(o.children)) {
				walk(o.children);
			}
		};
		walk(node);
		return parts.join("").replace(/\s+/g, " ").trim();
	};

	/** 收集某 sense 节点子树里的释义 li 与例句 */
	const renderSense = (senseNode: Record<string, unknown>): void => {
		const content = senseNode.content;
		const children = Array.isArray(content)
			? content
			: content != null
				? [content]
				: [];
		// 本 sense 的词性（misc-info 等 span）+ 释义 li
		const tags: string[] = [];
		const glosses: string[] = [];
		const examples: string[] = [];
		for (const child of children) {
			if (typeof child !== "object" || child == null) {
				continue;
			}
			const c = child as Record<string, unknown>;
			const dc = dataContent(c);
			if (dc === "glossary") {
				// glossary ul → 每个 li 是一条释义
				const lis = collectTag(c, "li");
				for (const li of lis) {
					const g = textOf(li);
					if (g) {
						glosses.push(g);
					}
				}
			} else if (dc === "example-sentence") {
				// 例句块：example-sentence-a 日文，example-sentence-b 译文
				const a = findDataContent(c, "example-sentence-a");
				const b = findDataContent(c, "example-sentence-b");
				const ja = a ? textOf(a) : "";
				const en = b ? textOf(b) : "";
				if (ja) {
					examples.push(ja);
				}
				if (en) {
					examples.push(en);
				}
			} else if (
				dc === "part-of-speech-info" ||
				dc === "misc-info"
			) {
				const t = textOf(c);
				if (t) {
					tags.push(t);
				}
			} else if (dc === "extra-info") {
				// extra-info 容器，递归找里面的 example-sentence
				walkForExamples(c, examples);
			}
		}
		// 词性标签（misc-info，如 colloquial）与释义拼在同一行，
		// 与用户期望的「① colloquial; 释义…」一致
		const marker = listMarker(senseNode);
		const head = marker ? `${marker} ` : "";
		const tagPrefix = tags.length > 0 ? `${tags.join("; ")}; ` : "";
		if (glosses.length > 0) {
			lines.push(`  ${head}${tagPrefix}${glosses.join("; ")}`);
		} else if (tags.length > 0) {
			lines.push(`  ${head}${tags.join("; ")};`);
		}
		for (const ex of examples) {
			lines.push(`    ${ex}`);
		}
	};

	/** 递归找 example-sentence 块，把日文/译文追加进 examples */
	const walkForExamples = (
		node: Record<string, unknown>,
		examples: string[],
	): void => {
		const content = node.content;
		const arr = Array.isArray(content)
			? content
			: content != null
				? [content]
				: [];
		for (const child of arr) {
			if (typeof child !== "object" || child == null) {
				continue;
			}
			const c = child as Record<string, unknown>;
			const dc = dataContent(c);
			if (dc === "example-sentence") {
				const a = findDataContent(c, "example-sentence-a");
				const b = findDataContent(c, "example-sentence-b");
				const ja = a ? textOf(a) : "";
				const en = b ? textOf(b) : "";
				if (ja) {
					examples.push(ja);
				}
				if (en) {
					examples.push(en);
				}
			} else {
				walkForExamples(c, examples);
			}
		}
	};

	/** 在 node 子树里找第一个 data.content === target 的节点 */
	const findDataContent = (
		node: Record<string, unknown>,
		target: string,
	): Record<string, unknown> | null => {
		const stack: Record<string, unknown>[] = [node];
		while (stack.length) {
			const n = stack.pop()!;
			if (dataContent(n) === target) {
				return n;
			}
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			for (const c of arr) {
				if (typeof c === "object" && c != null) {
					stack.push(c as Record<string, unknown>);
				}
			}
		}
		return null;
	};

	/** 在 node 子树里按文档顺序收集所有 tag === tagName 的节点 */
	const collectTag = (
		node: Record<string, unknown>,
		tagName: string,
	): Record<string, unknown>[] => {
		const out: Record<string, unknown>[] = [];
		// 深度优先、前序遍历，保持文档顺序
		const visit = (n: Record<string, unknown>): void => {
			if (n.tag === tagName) {
				out.push(n);
			}
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			for (const c of arr) {
				if (typeof c === "object" && c != null) {
					visit(c as Record<string, unknown>);
				}
			}
		};
		visit(node);
		return out;
	};

	/**
	 * 在 sense-group 子树里按文档顺序收集所有 data.content === "sense" 的节点，
	 * 不递归进嵌套的 sense-group（保持分组边界）。
	 * 不依赖 sense 节点的 tag（Jitendex 里可能是 li 或 div）。
	 */
	const collectSensesInGroup = (
		node: Record<string, unknown>,
	): Record<string, unknown>[] => {
		const out: Record<string, unknown>[] = [];
		const visit = (n: Record<string, unknown>): void => {
			const dc = dataContent(n);
			if (dc === "sense") {
				out.push(n);
				return; // sense 子树不再下钻（其内部由 renderSense 处理）
			}
			if (dc === "sense-group" && n !== node) {
				return; // 不跨组
			}
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			for (const c of arr) {
				if (typeof c === "object" && c != null) {
					visit(c as Record<string, unknown>);
				}
			}
		};
		visit(node);
		return out;
	};

	/** 递归遍历，处理 sense-group 与 sense */
	const walk = (node: unknown): void => {
		if (node == null) {
			return;
		}
		if (Array.isArray(node)) {
			for (const c of node) {
				walk(c);
			}
			return;
		}
		if (typeof node !== "object") {
			return;
		}
		const n = node as Record<string, unknown>;
		const dc = dataContent(n);

		// 跳过来源/署名块（JMdict | Tatoeba）
		if (dc === "attribution") {
			return;
		}
		// sense-group：先输出其词性标签，再遍历其中的 sense 节点
		if (dc === "sense-group") {
			const content = n.content;
			const arr = Array.isArray(content)
				? content
				: content != null
					? [content]
					: [];
			const groupTags: string[] = [];
			for (const child of arr) {
				if (typeof child !== "object" || child == null) {
					continue;
				}
				const c = child as Record<string, unknown>;
				const cdc = dataContent(c);
				if (cdc === "part-of-speech-info" || cdc === "misc-info") {
					const t = textOf(c);
					if (t) {
						groupTags.push(t);
					}
				}
			}
			if (groupTags.length > 0) {
				lines.push(`  ${groupTags.join("; ")};`);
			}
			// 遍历 sense-group 子树里的 sense 节点（按 data.content 识别，
			// 不依赖 tag 是 ol/li 还是 div —— Jitendex 各词的 sense 容器 tag 不固定）
			for (const s of collectSensesInGroup(n)) {
				renderSense(s);
			}
			return;
		}
		// 兼容：裸 sense 节点
		if (dc === "sense") {
			renderSense(n);
			return;
		}
		// structured-content / 容器节点：递归
		if (
			n.type === "structured-content" ||
			n.type === "structured" ||
			n.content !== undefined
		) {
			walk(n.content);
		}
	};

	walk(glossary);

	// 兜底：若结构化解析无产出（非 Jitendex 的纯文本 glossary），
	// 把所有文本拼成一条释义。
	if (lines.length === 0) {
		const flat = textOf(glossary);
		if (flat) {
			lines.push(`  ${flat}`);
		}
	}
	return lines;
}
