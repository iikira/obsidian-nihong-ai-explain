export interface FuriganaSegment {
	text: string;
	reading: string;
}

const HIRAGANA_START = 0x3040;
const HIRAGANA_END = 0x309f;
const KATAKANA_START = 0x30a0;
const KATAKANA_END = 0x30ff;
const KANJI_START = 0x4e00;
const KANJI_END = 0x9faf;

function isKana(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (
		(code >= HIRAGANA_START && code <= HIRAGANA_END) ||
		(code >= KATAKANA_START && code <= KATAKANA_END)
	);
}

function isKanji(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code >= KANJI_START && code <= KANJI_END;
}

/** 片假名转平假名（code point - 0x60） */
function normalizeKana(s: string): string {
	let result = "";
	for (const char of s) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= KATAKANA_START && code <= KATAKANA_END) {
			result += String.fromCodePoint(code - 0x60);
		} else {
			result += char;
		}
	}
	return result;
}

interface ExpressionBlock {
	text: string;
	isKanji: boolean;
}

/** 把 expression 切成「汉字块/假名块」序列 */
function getExpressionBlocks(expression: string): ExpressionBlock[] {
	const blocks: ExpressionBlock[] = [];
	for (const char of expression) {
		const isK = isKanji(char);
		if (blocks.length > 0 && blocks[blocks.length - 1].isKanji === isK) {
			blocks[blocks.length - 1].text += char;
		} else {
			blocks.push({ text: char, isKanji: isK });
		}
	}
	return blocks;
}

/**
 * 把 expression+reading 对齐成振假名段。
 * 算法：把 expression 切成汉字块/假名块，递归回溯让 reading 的剩余部分匹配汉字块。
 */
export function getFuriganaSegments(
	expression: string,
	reading: string
): FuriganaSegment[] {
	const blocks = getExpressionBlocks(expression);
	const normalizedReading = normalizeKana(reading);
	const result: FuriganaSegment[] = [];

	function align(blockIndex: number, readingOffset: number): boolean {
		if (blockIndex >= blocks.length) {
			return readingOffset === normalizedReading.length;
		}
		const block = blocks[blockIndex];
		if (!block.isKanji) {
			// 假名块：必须与 reading 对应位置一致（片假名归一化后比较）
			const blockText = normalizeKana(block.text);
			const readingSlice = normalizedReading.slice(
				readingOffset,
				readingOffset + blockText.length
			);
			if (readingSlice !== blockText) {
				return false;
			}
			result.push({ text: block.text, reading: "" });
			return align(blockIndex + 1, readingOffset + blockText.length);
		}
		// 汉字块：尝试所有可能的 reading 长度（至少 1）
		for (
			let len = 1;
			readingOffset + len <= normalizedReading.length;
			++len
		) {
			const subReading = normalizedReading.slice(
				readingOffset,
				readingOffset + len
			);
			result.push({ text: block.text, reading: subReading });
			if (align(blockIndex + 1, readingOffset + len)) {
				return true;
			}
			result.pop();
		}
		return false;
	}

	if (align(0, 0)) {
		return result;
	}
	// 对齐失败：整段作为一个 segment，reading 作为整体注音
	return [{ text: expression, reading: reading }];
}
