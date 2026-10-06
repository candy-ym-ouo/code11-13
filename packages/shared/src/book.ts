import { formatAcquired, isTimeUncertain, timelineGroupKey } from './date';
import type { Category, PersonRole, Precision } from './enums';
import { CATEGORY_LABELS } from './enums';

/**
 * 家史册编排：把「已发布且全家可见」的条目组织成一本可离线阅读的书。
 * 这里只做纯数据规划（章节、顺序、索引），不涉及数据库与文件，
 * 渲染层（apps/api/src/book/render.ts）拿到规划后生成静态 HTML。
 */

export const BOOK_VOLUMES = ['era', 'person'] as const;
export type BookVolume = (typeof BOOK_VOLUMES)[number];

export const BOOK_VOLUME_LABELS: Record<BookVolume, string> = {
  era: '编年卷',
  person: '人物卷',
};

export interface BookOptions {
  /** 书名，默认「<家庭名>家史册」 */
  title: string;
  /** 收录哪些卷（编年 / 人物），至少一卷 */
  volumes: BookVolume[];
}

/** 编排所需的最小条目信息（可 JSON 序列化）。 */
export interface BookEntryInput {
  id: string;
  title: string;
  category: Category;
  acquiredAt: string | null;
  acquiredPrecision: Precision;
  acquiredLabel: string | null;
  /** 时间轴落位时间（ISO），由服务端 sortAt 给出 */
  sortAt: string;
  placeText: string | null;
  placeCity: string | null;
  placeProvince: string | null;
  tags: string[];
  people: { personId: string; role: PersonRole }[];
}

export interface BookPersonInput {
  id: string;
  name: string;
  relation: string | null;
  birthYear: number | null;
  deathYear: number | null;
}

export interface EraChapter {
  /** 分组键：'1978' / '1970s' / 'unknown' */
  key: string;
  title: string;
  entryIds: string[];
}

export interface PersonChapter {
  personId: string;
  entryIds: string[];
}

export interface PlaceGroup {
  label: string;
  entryIds: string[];
}

export interface BookPlan {
  /** 条目 id → 全书统一编号（1 起，按时间升序） */
  entrySeq: Record<string, number>;
  /** 条目 id → 书内相对路径，如 entries/0003-abc.html */
  entryFile: Record<string, string>;
  eraChapters: EraChapter[];
  personChapters: PersonChapter[];
  /** 人物索引：按姓名排序的 personId 列表 */
  peopleIndex: string[];
  /** 条目索引：按标题排序的条目 id 列表 */
  titleIndex: string[];
  /** 地点索引：按地点归组的条目 */
  placeIndex: PlaceGroup[];
}

/** 中文排序（人名、标题、地名统一按拼音排）。 */
const zh = new Intl.Collator('zh-Hans-CN');

/** 年代章节标题：与站内时间轴同一套分组键，保证书内书外口径一致。 */
export function eraChapterTitle(key: string): string {
  if (key === 'unknown') return '时间不详';
  if (key.endsWith('s')) return `${key.slice(0, -1)} 年代`;
  return `${key} 年`;
}

export function entryFileName(seq: number, id: string): string {
  return `entries/${String(seq).padStart(4, '0')}-${id}.html`;
}

export function eraFileName(key: string): string {
  return `era/${key}.html`;
}

export function personFileName(personId: string): string {
  return `people/${personId}.html`;
}

/** 条目在系统内的原始链接：书里每一页都保留它，方便回到系统看最新版本。 */
export function entrySourceUrl(appUrl: string, familyId: string, itemId: string): string {
  return `${appUrl.replace(/\/+$/, '')}/f/${familyId}/items/${itemId}`;
}

function acquiredOf(e: BookEntryInput) {
  return {
    acquiredAt: e.acquiredAt,
    acquiredPrecision: e.acquiredPrecision,
    acquiredLabel: e.acquiredLabel,
  };
}

function byTimeThenTitle(a: BookEntryInput, b: BookEntryInput): number {
  const t = a.sortAt.localeCompare(b.sortAt);
  if (t !== 0) return t;
  return zh.compare(a.title, b.title);
}

function placeLabelOf(e: BookEntryInput): string | null {
  const label = [e.placeProvince, e.placeCity, e.placeText].filter(Boolean).join(' · ');
  return label || null;
}

/**
 * 生成全书编排规划。
 * 编年卷：按时间轴分组键分章（年 / 年代 / 时间不详），章内按时间升序；
 * 人物卷：每位有关联条目的人物一章，章内按时间升序；
 * 索引：人物按姓名、条目按标题、地点按组合标签，全部中文排序。
 */
export function buildBookPlan(
  entries: BookEntryInput[],
  people: BookPersonInput[],
  options: BookOptions,
): BookPlan {
  const sorted = [...entries].sort(byTimeThenTitle);
  const entrySeq: Record<string, number> = {};
  const entryFile: Record<string, string> = {};
  sorted.forEach((e, i) => {
    entrySeq[e.id] = i + 1;
    entryFile[e.id] = entryFileName(i + 1, e.id);
  });

  // ---- 编年卷 ----
  const eraChapters: EraChapter[] = [];
  if (options.volumes.includes('era')) {
    const groups = new Map<string, BookEntryInput[]>();
    for (const e of sorted) {
      const key = timelineGroupKey(acquiredOf(e), e.sortAt);
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === 'unknown') return 1;
      if (b === 'unknown') return -1;
      // '1978' 与 '1970s' 混合时按数值前缀比较，保证时间线单调
      return parseInt(a, 10) - parseInt(b, 10);
    });
    for (const key of keys) {
      eraChapters.push({
        key,
        title: eraChapterTitle(key),
        entryIds: groups.get(key)!.map((e) => e.id),
      });
    }
  }

  // ---- 人物卷 ----
  const peopleIndex = [...people].sort((a, b) => zh.compare(a.name, b.name)).map((p) => p.id);
  const personChapters: PersonChapter[] = [];
  if (options.volumes.includes('person')) {
    const byPerson = new Map<string, BookEntryInput[]>();
    for (const e of sorted) {
      for (const link of e.people) {
        const list = byPerson.get(link.personId) ?? [];
        list.push(e);
        byPerson.set(link.personId, list);
      }
    }
    for (const personId of peopleIndex) {
      const list = byPerson.get(personId);
      if (list && list.length > 0) {
        personChapters.push({ personId, entryIds: list.map((e) => e.id) });
      }
    }
  }

  // ---- 索引 ----
  const titleIndex = [...entries].sort((a, b) => zh.compare(a.title, b.title)).map((e) => e.id);

  const placeGroups = new Map<string, string[]>();
  for (const e of sorted) {
    const label = placeLabelOf(e);
    if (!label) continue;
    const list = placeGroups.get(label) ?? [];
    list.push(e.id);
    placeGroups.set(label, list);
  }
  const placeIndex: PlaceGroup[] = [...placeGroups.entries()]
    .map(([label, entryIds]) => ({ label, entryIds }))
    .sort((a, b) => zh.compare(a.label, b.label));

  return { entrySeq, entryFile, eraChapters, personChapters, peopleIndex, titleIndex, placeIndex };
}

/** 渲染层辅助：条目展示信息（规划之外、页面之内共用的展示口径）。 */
export function entryDisplayOf(e: BookEntryInput) {
  return {
    acquiredDisplay: formatAcquired(acquiredOf(e)),
    timeUncertain: isTimeUncertain(acquiredOf(e)),
    categoryLabel: CATEGORY_LABELS[e.category],
    placeLabel: placeLabelOf(e),
  };
}

/** 人物生卒年展示：「1932—2001」「1932—」，都没有时返回空串。 */
export function personYearsOf(p: Pick<BookPersonInput, 'birthYear' | 'deathYear'>): string {
  if (p.birthYear && p.deathYear) return `${p.birthYear}—${p.deathYear}`;
  if (p.birthYear) return `${p.birthYear}—`;
  if (p.deathYear) return `—${p.deathYear}`;
  return '';
}
