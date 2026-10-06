import { CATEGORY_LABELS } from './enums';
import type { Category, PersonRole } from './enums';

/**
 * 家史册排版（纯函数层）。
 * 这里只依赖条目/人物的视图数据，不碰数据库与文件系统，
 * 这样「年代分卷、人物分卷、索引归并」的规则可以单测，也能被任何渲染端复用。
 */

/** 排版用的条目视图：字段在 API 层从 Prisma 行映射而来。 */
export interface BookEntry {
  id: string;
  title: string;
  category: Category;
  /** 展示用时间文案（formatAcquired 的结果），如「1978 年」「我上小学那年」 */
  acquiredDisplay: string;
  /** 时间存疑（精度粗于月或说不清），书页上要明确标注 */
  timeUncertain: boolean;
  /** 时间完全说不清：进「时间不详」附录章，不参与年代分卷 */
  timeUnknown: boolean;
  /** 时间轴落位时间（ISO）；timeUnknown 时是创建时间，仅用于附录章内排序 */
  sortAt: string;
  /** 已拼接好的地点文案；null 表示未记录 */
  place: string | null;
  tags: string[];
  people: { personId: string; name: string; role: PersonRole }[];
  /** 故事纯文本摘要 */
  excerpt: string;
}

export interface BookPerson {
  id: string;
  name: string;
  relation: string | null;
  birthYear: number | null;
  deathYear: number | null;
  bio: string | null;
}

export interface BookChapter {
  /** 文件名安全的标识：era-1950s / era-unknown / person-<id> */
  slug: string;
  volume: 'era' | 'person';
  title: string;
  subtitle: string | null;
  entryIds: string[];
}

export interface BookIndexGroup {
  key: string;
  label: string;
  entryIds: string[];
}

const zh = new Intl.Collator('zh-Hans-CN');

/** 故事摘要：折叠空白后截断，避免卡片里出现大段文字。 */
export function excerptOf(text: string | null | undefined, max = 140): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 年代落位：返回分组键与章节名。说不清的条目统一进附录。 */
export function eraOf(entry: Pick<BookEntry, 'sortAt' | 'timeUnknown'>): { key: string; label: string } {
  if (entry.timeUnknown) return { key: 'unknown', label: '时间不详' };
  const year = new Date(entry.sortAt).getUTCFullYear();
  if (Number.isNaN(year)) return { key: 'unknown', label: '时间不详' };
  const decade = Math.floor(year / 10) * 10;
  return { key: `${decade}s`, label: `${decade} 年代` };
}

function bySortAt(a: BookEntry, b: BookEntry): number {
  const diff = new Date(a.sortAt).getTime() - new Date(b.sortAt).getTime();
  return diff !== 0 ? diff : zh.compare(a.title, b.title);
}

/** 卷一 · 年代志：每个年代一章，按时间先后排列；「时间不详」作为附录章永远在最后。 */
export function planEraChapters(entries: BookEntry[]): BookChapter[] {
  const groups = new Map<string, { label: string; entries: BookEntry[] }>();
  for (const entry of entries) {
    const era = eraOf(entry);
    const group = groups.get(era.key) ?? { label: era.label, entries: [] };
    group.entries.push(entry);
    groups.set(era.key, group);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'unknown') return 1;
    if (b === 'unknown') return -1;
    return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  });
  return keys.map((key) => {
    const group = groups.get(key)!;
    const ordered = [...group.entries].sort(bySortAt);
    return {
      slug: `era-${key}`,
      volume: 'era' as const,
      title: key === 'unknown' ? '附录 · 时间不详' : group.label,
      subtitle: key === 'unknown' ? '这些条目暂时无法落位到时间轴，待家人补充线索。' : null,
      entryIds: ordered.map((e) => e.id),
    };
  });
}

/** 人物生卒年展示：「1932—2018」「1932—」「—2018」，都没有则 null。 */
export function personLifespan(person: Pick<BookPerson, 'birthYear' | 'deathYear'>): string | null {
  const birth = person.birthYear ? String(person.birthYear) : '';
  const death = person.deathYear ? String(person.deathYear) : '';
  if (!birth && !death) return null;
  return `${birth || '？'}—${death || '？'}`;
}

/**
 * 卷二 · 人物志：每位被条目引用的人物一章。
 * 章节顺序按「相关条目数 → 姓名」排列，让着墨最多的人排在前面。
 */
export function planPersonChapters(entries: BookEntry[], people: BookPerson[]): BookChapter[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const linked = new Map<string, BookEntry[]>();
  for (const entry of entries) {
    for (const ref of entry.people) {
      if (!byId.has(ref.personId)) continue;
      const list = linked.get(ref.personId) ?? [];
      list.push(entry);
      linked.set(ref.personId, list);
    }
  }
  const chapters: BookChapter[] = [];
  for (const [personId, list] of linked) {
    const person = byId.get(personId)!;
    const lifespan = personLifespan(person);
    const ordered = [...list].sort(bySortAt);
    chapters.push({
      slug: `person-${personId}`,
      volume: 'person',
      title: person.name,
      subtitle: [person.relation, lifespan ? `（${lifespan}）` : null].filter(Boolean).join(' ') || null,
      entryIds: ordered.map((e) => e.id),
    });
  }
  return chapters.sort((a, b) => b.entryIds.length - a.entryIds.length || zh.compare(a.title, b.title));
}

function groupEntries(entries: BookEntry[], keyOf: (e: BookEntry) => string | null): Map<string, BookEntry[]> {
  const map = new Map<string, BookEntry[]>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(entry);
    map.set(key, list);
  }
  return map;
}

function toIndexGroups(map: Map<string, BookEntry[]>, labelOf: (key: string) => string): BookIndexGroup[] {
  return [...map.entries()]
    .map(([key, list]) => ({
      key,
      label: labelOf(key),
      entryIds: [...list].sort(bySortAt).map((e) => e.id),
    }))
    .sort((a, b) => zh.compare(a.label, b.label));
}

/** 人物索引：按姓名排序，标注关系。 */
export function buildPeopleIndex(entries: BookEntry[], people: BookPerson[]): BookIndexGroup[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const map = new Map<string, BookEntry[]>();
  for (const entry of entries) {
    for (const ref of entry.people) {
      if (!byId.has(ref.personId)) continue;
      const list = map.get(ref.personId) ?? [];
      list.push(entry);
      map.set(ref.personId, list);
    }
  }
  return toIndexGroups(map, (id) => {
    const person = byId.get(id)!;
    return person.relation ? `${person.name}（${person.relation}）` : person.name;
  });
}

/** 地点索引：未记录地点的条目不进入索引。 */
export function buildPlaceIndex(entries: BookEntry[]): BookIndexGroup[] {
  return toIndexGroups(groupEntries(entries, (e) => e.place), (place) => place);
}

/** 标签索引：一个条目有几个标签就出现在几组里。 */
export function buildTagIndex(entries: BookEntry[]): BookIndexGroup[] {
  const map = new Map<string, BookEntry[]>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const list = map.get(tag) ?? [];
      list.push(entry);
      map.set(tag, list);
    }
  }
  return toIndexGroups(map, (tag) => `#${tag}`);
}

/** 分类索引：固定按五分类声明顺序，而不是按名称。 */
export function buildCategoryIndex(entries: BookEntry[]): BookIndexGroup[] {
  const groups = toIndexGroups(groupEntries(entries, (e) => e.category), (c) => CATEGORY_LABELS[c as Category] ?? c);
  const order = Object.keys(CATEGORY_LABELS) as Category[];
  return groups.sort((a, b) => order.indexOf(a.key as Category) - order.indexOf(b.key as Category));
}
