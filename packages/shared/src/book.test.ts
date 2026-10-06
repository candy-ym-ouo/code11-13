import { describe, expect, it } from 'vitest';
import {
  buildCategoryIndex,
  buildPeopleIndex,
  buildPlaceIndex,
  buildTagIndex,
  eraOf,
  excerptOf,
  personLifespan,
  planEraChapters,
  planPersonChapters,
} from './book';
import type { BookEntry, BookPerson } from './book';

function entry(partial: Partial<BookEntry> & { id: string }): BookEntry {
  return {
    title: partial.id,
    category: 'other',
    acquiredDisplay: '时间不详',
    timeUncertain: true,
    timeUnknown: true,
    sortAt: '2020-01-01T00:00:00.000Z',
    place: null,
    tags: [],
    people: [],
    excerpt: '',
    ...partial,
  };
}

const people: BookPerson[] = [
  { id: 'p1', name: '张德山', relation: '外公', birthYear: 1932, deathYear: 2018, bio: null },
  { id: 'p2', name: '李秀兰', relation: '外婆', birthYear: 1935, deathYear: null, bio: null },
];

describe('eraOf', () => {
  it('按年代落位', () => {
    expect(eraOf(entry({ id: 'a', timeUnknown: false, sortAt: '1978-06-01T00:00:00.000Z' }))).toEqual({
      key: '1970s',
      label: '1970 年代',
    });
  });

  it('说不清的条目进附录', () => {
    expect(eraOf(entry({ id: 'a' })).key).toBe('unknown');
  });
});

describe('planEraChapters', () => {
  it('年代章按时间排序，附录章在最后', () => {
    const chapters = planEraChapters([
      entry({ id: 'c', timeUnknown: false, sortAt: '1991-01-01T00:00:00.000Z' }),
      entry({ id: 'a', timeUnknown: false, sortAt: '1955-01-01T00:00:00.000Z' }),
      entry({ id: 'u' }),
      entry({ id: 'b', timeUnknown: false, sortAt: '1978-01-01T00:00:00.000Z' }),
    ]);
    expect(chapters.map((c) => c.slug)).toEqual(['era-1950s', 'era-1970s', 'era-1990s', 'era-unknown']);
    expect(chapters[3]!.title).toBe('附录 · 时间不详');
  });

  it('章内条目按落位时间排序', () => {
    const [chapter] = planEraChapters([
      entry({ id: 'late', timeUnknown: false, sortAt: '1979-01-01T00:00:00.000Z' }),
      entry({ id: 'early', timeUnknown: false, sortAt: '1971-01-01T00:00:00.000Z' }),
    ]);
    expect(chapter!.entryIds).toEqual(['early', 'late']);
  });
});

describe('planPersonChapters', () => {
  it('只给有条目的人物立章，按条目数排序', () => {
    const chapters = planPersonChapters(
      [
        entry({ id: 'a', people: [{ personId: 'p1', name: '张德山', role: 'source' }] }),
        entry({ id: 'b', people: [{ personId: 'p1', name: '张德山', role: 'gifted' }] }),
        entry({ id: 'c', people: [{ personId: 'p2', name: '李秀兰', role: 'source' }] }),
      ],
      people,
    );
    expect(chapters.map((c) => c.slug)).toEqual(['person-p1', 'person-p2']);
    expect(chapters[0]!.entryIds).toEqual(['a', 'b']);
    expect(chapters[0]!.subtitle).toBe('外公 （1932—2018）');
  });

  it('已合并/删除的人物（不在名册里）不立章', () => {
    const chapters = planPersonChapters(
      [entry({ id: 'a', people: [{ personId: 'ghost', name: '幽灵', role: 'source' }] })],
      people,
    );
    expect(chapters).toEqual([]);
  });
});

describe('索引', () => {
  const entries = [
    entry({ id: 'a', category: 'furniture', place: '江苏 南京 老宅', tags: ['嫁妆'], people: [{ personId: 'p2', name: '李秀兰', role: 'source' }] }),
    entry({ id: 'b', category: 'receipt', place: '江苏 南京 老宅', tags: ['嫁妆', '票据'] }),
    entry({ id: 'c', category: 'furniture', place: null, tags: [] }),
  ];

  it('人物索引按姓名排序并带关系', () => {
    const groups = buildPeopleIndex(entries, people);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('李秀兰（外婆）');
    expect(groups[0]!.entryIds).toEqual(['a']);
  });

  it('地点索引跳过未记录地点的条目', () => {
    const groups = buildPlaceIndex(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entryIds).toEqual(['a', 'b']);
  });

  it('标签索引允许条目出现在多组', () => {
    const groups = buildTagIndex(entries);
    expect(groups.map((g) => g.key).sort()).toEqual(['嫁妆', '票据']);
    expect(groups.find((g) => g.key === '嫁妆')!.entryIds).toEqual(['a', 'b']);
  });

  it('分类索引按声明顺序排列', () => {
    const groups = buildCategoryIndex(entries);
    expect(groups.map((g) => g.key)).toEqual(['furniture', 'receipt']);
    expect(groups[0]!.entryIds).toEqual(['a', 'c']);
  });
});

describe('excerptOf / personLifespan', () => {
  it('摘要折叠空白并截断', () => {
    expect(excerptOf('  一段\n\n故事  ')).toBe('一段 故事');
    expect(excerptOf('长'.repeat(200))).toHaveLength(141);
    expect(excerptOf(null)).toBe('');
  });

  it('生卒年缺一侧时用问号占位', () => {
    expect(personLifespan({ birthYear: 1932, deathYear: 2018 })).toBe('1932—2018');
    expect(personLifespan({ birthYear: 1932, deathYear: null })).toBe('1932—？');
    expect(personLifespan({ birthYear: null, deathYear: null })).toBeNull();
  });
});
