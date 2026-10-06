import { describe, expect, it } from 'vitest';
import { buildBookPlan, type BookEntryInput, type BookPersonInput } from '@heirloom/shared';
import { renderBook, type BookModel } from './render';

function makeModel(): BookModel {
  const entries: BookEntryInput[] = [
    {
      id: 'item-1',
      title: '外公的樟木箱',
      category: 'furniture',
      acquiredAt: '1978-01-01T00:00:00.000Z',
      acquiredPrecision: 'year',
      acquiredLabel: null,
      sortAt: '1978-07-02T00:00:00.000Z',
      placeText: '老家堂屋',
      placeCity: '绍兴市',
      placeProvince: '浙江省',
      tags: ['樟木'],
      people: [{ personId: 'p1', role: 'source' }],
    },
    {
      id: 'item-2',
      title: '自行车发票',
      category: 'receipt',
      acquiredAt: null,
      acquiredPrecision: 'unknown',
      acquiredLabel: '记不清了',
      sortAt: '2024-01-01T00:00:00.000Z',
      placeText: null,
      placeCity: null,
      placeProvince: null,
      tags: [],
      people: [],
    },
  ];
  const people: BookPersonInput[] = [
    { id: 'p1', name: '外公', relation: '外公', birthYear: 1932, deathYear: 2001 },
  ];
  const plan = buildBookPlan(entries, people, { title: '老张家家史册', volumes: ['era', 'person'] });
  return {
    title: '老张家家史册',
    familyName: '老张家',
    familyId: 'fam1',
    sourceUrl: 'http://localhost:4000',
    generatedAt: new Date('2026-10-06T08:00:00.000Z'),
    options: { title: '老张家家史册', volumes: ['era', 'person'] },
    plan,
    entries: [
      {
        id: 'item-1',
        title: '外公的樟木箱',
        categoryLabel: '老家具',
        acquiredDisplay: '1978 年',
        timeUncertain: true,
        acquiredNote: '按户口本推算',
        placeLabel: '浙江省 · 绍兴市 · 老家堂屋',
        storyHtml: '<p>箱底有名字。</p>',
        condition: '锁扣缺失',
        storageLocation: '储藏间',
        tags: ['樟木'],
        people: [{ personId: 'p1', name: '外公', role: 'source' }],
        media: [
          {
            kind: 'image',
            file: 'media/web/abc-lg.webp',
            thumbFile: 'media/web/abc-thumb.webp',
            originalName: '箱子.jpg',
            caption: '箱底刻字',
            transcript: null,
            durationMs: null,
          },
          {
            kind: 'audio',
            file: 'media/web/def.mp3',
            thumbFile: null,
            originalName: '口述.wav',
            caption: null,
            transcript: '那年搬家……',
            durationMs: 60_000,
          },
        ],
        creatorName: '大姐',
      },
      {
        id: 'item-2',
        title: '自行车发票',
        categoryLabel: '票据',
        acquiredDisplay: '记不清了',
        timeUncertain: true,
        acquiredNote: null,
        placeLabel: null,
        storyHtml: null,
        condition: null,
        storageLocation: null,
        tags: [],
        people: [],
        media: [],
        creatorName: '大姐',
      },
    ],
    people: [{ id: 'p1', name: '外公', relation: '外公', birthYear: 1932, deathYear: 2001, bio: '一辈子木匠。' }],
  };
}

describe('renderBook · 静态站点', () => {
  const model = makeModel();
  const pages = renderBook(model);
  const byPath = new Map(pages.map((p) => [p.path, p.content]));

  it('生成封面、章节、条目页、索引与样式表', () => {
    expect(byPath.has('index.html')).toBe(true);
    expect(byPath.has('assets/book.css')).toBe(true);
    expect(byPath.has('era/1978.html')).toBe(true);
    expect(byPath.has('era/unknown.html')).toBe(true);
    expect(byPath.has('people/p1.html')).toBe(true);
    expect(byPath.has('entries/0001-item-1.html')).toBe(true);
    expect(byPath.has('entries/0002-item-2.html')).toBe(true);
    expect(byPath.has('index/entries.html')).toBe(true);
    expect(byPath.has('index/people.html')).toBe(true);
    expect(byPath.has('index/places.html')).toBe(true);
  });

  it('封面总目录列出两卷章节与索引入口', () => {
    const cover = byPath.get('index.html')!;
    expect(cover).toContain('编年卷');
    expect(cover).toContain('人物卷');
    expect(cover).toContain('era/1978.html');
    expect(cover).toContain('people/p1.html');
    expect(cover).toContain('index/entries.html');
    expect(cover).toContain('共 2 条');
  });

  it('条目页保留系统原始条目链接', () => {
    const entry = byPath.get('entries/0001-item-1.html')!;
    expect(entry).toContain('http://localhost:4000/f/fam1/items/item-1');
    expect(entry).toContain('系统原始条目');
  });

  it('条目页使用相对路径引用媒体，离线可用', () => {
    const entry = byPath.get('entries/0001-item-1.html')!;
    expect(entry).toContain('../media/web/abc-lg.webp');
    expect(entry).toContain('<audio controls');
    expect(entry).toContain('../media/web/def.mp3');
    expect(entry).toContain('那年搬家……'); // 听写稿
    // 不引用任何外部资源
    expect(entry).not.toMatch(/src="https?:\/\//);
    expect(entry).not.toMatch(/href="https?:\/\/(?!localhost)/);
  });

  it('用户输入的文本全部转义，故事 HTML 按白名单原样嵌入', () => {
    const entry = byPath.get('entries/0001-item-1.html')!;
    expect(entry).toContain('<p>箱底有名字。</p>');
    expect(entry).toContain('箱底刻字');
  });

  it('人物章包含小传与按角色分组的条目', () => {
    const person = byPath.get('people/p1.html')!;
    expect(person).toContain('一辈子木匠。');
    expect(person).toContain('1932—2001');
    expect(person).toContain('来源');
    expect(person).toContain('../entries/0001-item-1.html');
  });

  it('编年章按时间列条目并带前后章导航', () => {
    const chapter = byPath.get('era/1978.html')!;
    expect(chapter).toContain('1978 年');
    expect(chapter).toContain('../entries/0001-item-1.html');
    expect(chapter).toContain('时间不详 →');
  });

  it('索引页可回到条目页', () => {
    const idx = byPath.get('index/entries.html')!;
    expect(idx).toContain('../entries/0001-item-1.html');
    expect(idx).toContain('../entries/0002-item-2.html');
    const places = byPath.get('index/places.html')!;
    expect(places).toContain('浙江省 · 绍兴市 · 老家堂屋');
  });

  it('所有页面间的相对链接都能落到书内文件（离线可用）', () => {
    const paths = new Set(pages.map((p) => p.path));
    // 媒体文件由 bookService 另行打包，这里把模型引用到的也算作存在
    for (const e of model.entries) {
      for (const m of e.media) {
        paths.add(m.file);
        if (m.thumbFile) paths.add(m.thumbFile);
      }
    }
    const broken: string[] = [];
    for (const page of pages) {
      if (!page.path.endsWith('.html')) continue;
      const fromDir = page.path.split('/').slice(0, -1).join('/');
      for (const match of page.content.matchAll(/(?:href|src)="([^"#]+)"/g)) {
        const url = match[1]!;
        if (/^https?:/.test(url) || url.startsWith('mailto:')) continue;
        const resolved = fromDir ? `${fromDir}/${url}` : url;
        const normalized = resolved
          .split('/')
          .reduce<string[]>((acc, seg) => {
            if (seg === '..') acc.pop();
            else if (seg !== '.' && seg !== '') acc.push(seg);
            return acc;
          }, [])
          .join('/');
        if (!paths.has(normalized)) broken.push(`${page.path} -> ${url}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
