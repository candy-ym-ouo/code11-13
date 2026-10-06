import { describe, expect, it } from 'vitest';
import {
  buildBookPlan,
  entryFileName,
  entrySourceUrl,
  eraChapterTitle,
  personYearsOf,
  type BookEntryInput,
  type BookPersonInput,
} from './book';

function entry(partial: Partial<BookEntryInput> & { id: string }): BookEntryInput {
  return {
    title: `条目 ${partial.id}`,
    category: 'other',
    acquiredAt: null,
    acquiredPrecision: 'unknown',
    acquiredLabel: null,
    sortAt: '2020-01-01T00:00:00.000Z',
    placeText: null,
    placeCity: null,
    placeProvince: null,
    tags: [],
    people: [],
    ...partial,
  };
}

const PEOPLE: BookPersonInput[] = [
  { id: 'p-b', name: '张三', relation: '外公', birthYear: 1932, deathYear: 2001 },
  { id: 'p-a', name: '李四', relation: '奶奶', birthYear: null, deathYear: null },
];

describe('buildBookPlan · 编年卷', () => {
  const entries = [
    entry({ id: 'e-year', acquiredAt: '1978-03-01T00:00:00.000Z', acquiredPrecision: 'year', sortAt: '1978-07-02T00:00:00.000Z' }),
    entry({ id: 'e-decade', acquiredAt: '1983-01-01T00:00:00.000Z', acquiredPrecision: 'decade', sortAt: '1985-01-01T00:00:00.000Z' }),
    entry({ id: 'e-unknown', acquiredLabel: '记不清了', sortAt: '2024-05-01T00:00:00.000Z' }),
    entry({ id: 'e-day', acquiredAt: '1978-03-12T00:00:00.000Z', acquiredPrecision: 'day', sortAt: '1978-03-12T00:00:00.000Z' }),
  ];

  it('按年 / 年代 / 时间不详分章，时间不详排在最后', () => {
    const plan = buildBookPlan(entries, [], { title: '测试', volumes: ['era'] });
    expect(plan.eraChapters.map((c) => c.key)).toEqual(['1978', '1980s', 'unknown']);
    expect(plan.eraChapters.map((c) => c.title)).toEqual(['1978 年', '1980 年代', '时间不详']);
  });

  it('章内按时间升序，全书编号与阅读顺序一致', () => {
    const plan = buildBookPlan(entries, [], { title: '测试', volumes: ['era'] });
    const chapter1978 = plan.eraChapters.find((c) => c.key === '1978')!;
    expect(chapter1978.entryIds).toEqual(['e-day', 'e-year']);
    expect(plan.entrySeq['e-day']).toBe(1);
    expect(plan.entrySeq['e-year']).toBe(2);
    expect(plan.entryFile['e-day']).toBe(entryFileName(1, 'e-day'));
  });

  it('不收录编年卷时不产生章节', () => {
    const plan = buildBookPlan(entries, [], { title: '测试', volumes: ['person'] });
    expect(plan.eraChapters).toEqual([]);
  });
});

describe('buildBookPlan · 人物卷与索引', () => {
  const entries = [
    entry({ id: 'e1', title: '樟木箱', sortAt: '1978-07-02T00:00:00.000Z', people: [{ personId: 'p-b', role: 'source' }] }),
    entry({ id: 'e2', title: '搪瓷缸', sortAt: '1985-01-01T00:00:00.000Z', people: [{ personId: 'p-b', role: 'gifted' }, { personId: 'p-a', role: 'source' }] }),
    entry({ id: 'e3', title: '发票', people: [] }),
  ];

  it('只给有关联条目的人物立章，章内按时间排序', () => {
    const plan = buildBookPlan(entries, PEOPLE, { title: '测试', volumes: ['person'] });
    expect(plan.personChapters.map((c) => c.personId)).toEqual(['p-a', 'p-b']);
    const zhangsan = plan.personChapters.find((c) => c.personId === 'p-b')!;
    expect(zhangsan.entryIds).toEqual(['e1', 'e2']);
  });

  it('人物索引按姓名排序，与是否有条目无关', () => {
    const plan = buildBookPlan(entries, PEOPLE, { title: '测试', volumes: ['era', 'person'] });
    expect(plan.peopleIndex).toEqual(['p-a', 'p-b']); // 李四 < 张三（拼音）
  });

  it('条目索引按标题排序', () => {
    const plan = buildBookPlan(entries, PEOPLE, { title: '测试', volumes: ['era'] });
    // 拼音序：发票(fa) < 搪瓷缸(tang) < 樟木箱(zhang)
    expect(plan.titleIndex).toEqual(['e3', 'e2', 'e1']);
  });

  it('地点索引按组合标签归组', () => {
    const withPlace = [
      entry({ id: 'x1', placeProvince: '浙江省', placeCity: '绍兴市', placeText: '老家堂屋' }),
      entry({ id: 'x2', placeProvince: '浙江省', placeCity: '绍兴市', placeText: '老家堂屋' }),
      entry({ id: 'x3', placeText: '单位宿舍' }),
      entry({ id: 'x4' }),
    ];
    const plan = buildBookPlan(withPlace, [], { title: '测试', volumes: ['era'] });
    expect(plan.placeIndex).toHaveLength(2);
    const shaoxing = plan.placeIndex.find((g) => g.label.includes('绍兴'))!;
    expect(shaoxing.entryIds).toEqual(['x1', 'x2']);
  });
});

describe('书册辅助函数', () => {
  it('年代章节标题与时间轴口径一致', () => {
    expect(eraChapterTitle('1978')).toBe('1978 年');
    expect(eraChapterTitle('1970s')).toBe('1970 年代');
    expect(eraChapterTitle('unknown')).toBe('时间不详');
  });

  it('原始条目链接指向系统内页面', () => {
    expect(entrySourceUrl('http://localhost:4000/', 'fam1', 'item9')).toBe('http://localhost:4000/f/fam1/items/item9');
  });

  it('生卒年展示', () => {
    expect(personYearsOf({ birthYear: 1932, deathYear: 2001 })).toBe('1932—2001');
    expect(personYearsOf({ birthYear: 1932, deathYear: null })).toBe('1932—');
    expect(personYearsOf({ birthYear: null, deathYear: null })).toBe('');
  });
});
