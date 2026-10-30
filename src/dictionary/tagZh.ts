/**
 * JMnedict 专有名词分类 tag → 中文释义（popup 与 buildDictionaryReference 共用，保证展示一致）。
 *
 * 仅 JMnedict（names dict，reading 为空）的 tag 做中文映射；Jitendex 词典的 tag 保持原样不映射。
 * 词典 tag_bank 的 notes 字段为空，悬停无内容；故 names dict 的 tag 直接在页面/prompt 附中文释义。
 * 组合 tag（如 "fem person"）按空格拆分逐个映射后用 / 拼接。
 */
const NAME_TAG_ZH: Record<string, string> = {
	surname: "姓",
	masc: "男名",
	fem: "女名",
	given: "名",
	male: "男",
	person: "人物",
	place: "地名",
	station: "车站",
	ship: "船名",
	organization: "组织",
	company: "公司",
	serv: "服务",
	work: "作品",
	char: "角色",
	fict: "虚构",
	leg: "传说",
	myth: "神话",
	dei: "神祇",
	relig: "宗教",
	group: "团体",
	product: "产品",
	ev: "事件",
	obj: "物品",
	doc: "文献",
	creat: "造物",
	oth: "其他",
	unclass: "未分类",
};

/** 把 names dict 的 tag 映射为中文释义（组合 tag 按空格拆分逐个映射后用 / 拼接） */
export function tagZh(tag: string): string {
	return tag
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => NAME_TAG_ZH[t] ?? t)
		.join("/");
}

/** 渲染 names dict 的 tag：英文原名 + 中文名（如 "surname 姓"、"fem person 女名/人物"）。
 *  中文与原 tag 相同（未命中映射）时只显示一次，避免重复。 */
export function tagLabel(tag: string): string {
	const zh = tagZh(tag);
	return zh === tag ? tag : `${tag} ${zh}`;
}

/**
 * 渲染 JMnedict（names dict）一条 term 为参考文本行（带缩进，与 popup 展示一致）：
 *   `  <tag 中文> <读音列表>`（tag 用 tagLabel 中文化，读音用顿号分隔）。
 * popup 与 buildDictionaryReference 共用此纯函数，保证展示一致。
 * @param tags term 的 tag 数组（如 ["surname"]）
 * @param glossary term 的 glossary（names dict 里是读音字符串数组）
 */
export function renderNamesDictTerm(tags: string[], glossary: unknown[]): string {
	const tagStr = tags.length
		? tags.map((t) => tagLabel(t)).join(" ") + " "
		: "";
	const readings = glossary.filter((g): g is string => typeof g === "string");
	return `  ${tagStr}${readings.join("、")}`;
}
