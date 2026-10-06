import { execSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from '@prisma/client';

/**
 * buildBookZip 的集成测试：不连数据库（mock prisma），但真实走
 * 「查询 → 排版 → 渲染 HTML → 复制媒体 → 打 ZIP」整条链路，
 * 并用系统 unzip 校验产物结构，保证书真的能离线打开。
 */

const FAMILY_ID = 'fam-book-test';
const PERSON_ID = 'clperson0000000000000001';
const ITEM_ID = 'clitem000000000000000001';
const MEDIA_KEY = 'tmp/book-test-image.webp';

const itemFindMany = vi.fn();
const personFindMany = vi.fn();

vi.mock('../db', () => ({
  prisma: {
    family: { findUniqueOrThrow: vi.fn(async () => ({ id: FAMILY_ID, name: '老张家' })) },
    person: { findMany: (...args: unknown[]) => personFindMany(...args) },
    item: { findMany: (...args: unknown[]) => itemFindMany(...args) },
    job: { update: vi.fn(async () => ({})) },
  },
}));

import { buildBookZip, bookZipPath } from './bookService';
import { config } from '../config';

const personRow = {
  id: PERSON_ID,
  familyId: FAMILY_ID,
  name: '张德山',
  relation: '外公',
  birthYear: 1932,
  deathYear: 2018,
  bio: '一辈子在木器社做活。',
  avatarMediaId: null,
  mergedIntoId: null,
  createdBy: 'user1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

const mediaRow = {
  id: 'clmedia00000000000000001',
  itemId: ITEM_ID,
  kind: 'image',
  status: 'ready',
  storageKey: MEDIA_KEY,
  sha256: 'a'.repeat(64),
  mimeType: 'image/webp',
  byteSize: BigInt(128),
  width: 100,
  height: 100,
  durationMs: null,
  thumbKey: null,
  largeKey: null,
  transcodeKey: null,
  waveformKey: null,
  originalName: '樟木箱.jpg',
  caption: '箱底有外公的名字',
  transcript: null,
  sortOrder: 0,
  lastError: null,
  createdBy: 'user1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

const itemRow = {
  id: ITEM_ID,
  familyId: FAMILY_ID,
  title: '外公的樟木箱',
  category: 'furniture',
  status: 'published',
  visibility: 'family',
  acquiredAt: new Date('1978-01-01T00:00:00.000Z'),
  acquiredPrecision: 'year',
  acquiredLabel: '我上小学那年',
  acquiredNote: '按户口本推算',
  placeText: '老家堂屋',
  placeCity: '绍兴市',
  placeProvince: '浙江省',
  placeCountry: null,
  placeLat: null,
  placeLng: null,
  storyHtml: '<p>外公亲手打的箱子。</p>',
  storyText: '外公亲手打的箱子。',
  condition: '箱体完好',
  storageLocation: '储藏间',
  tags: ['樟木'],
  coverMediaId: null,
  sortAt: new Date('1978-07-02T00:00:00.000Z'),
  createdBy: 'user1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
  media: [mediaRow],
  people: [{ id: 'cllink000000000000000001', itemId: ITEM_ID, personId: PERSON_ID, role: 'source', person: personRow }],
  creator: { displayName: '大姐' },
};

function fakeJob(payload: unknown): Job {
  return {
    id: 'cljob0000000000000000001',
    familyId: FAMILY_ID,
    type: 'book_build',
    payload: payload as never,
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    result: null,
    lastError: null,
    runAfter: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function unzipList(zip: string): string {
  return execSync(`unzip -l ${JSON.stringify(zip)}`, { encoding: 'utf8' });
}

function unzipRead(zip: string, pattern: string): string {
  return execSync(`unzip -p ${JSON.stringify(zip)} ${JSON.stringify(pattern)}`, { encoding: 'utf8' });
}

beforeAll(async () => {
  personFindMany.mockResolvedValue([personRow]);
  itemFindMany.mockResolvedValue([itemRow]);
  // 放一份真实媒体文件，让随书复制走真实路径
  await fsp.mkdir(path.dirname(path.join(config.STORAGE_ROOT, MEDIA_KEY)), { recursive: true });
  await fsp.writeFile(path.join(config.STORAGE_ROOT, MEDIA_KEY), Buffer.from('fake-webp-bytes'));
});

afterAll(async () => {
  await fsp.rm(path.dirname(bookZipPath(FAMILY_ID, 'x')), { recursive: true, force: true });
  await fsp.rm(path.join(config.STORAGE_ROOT, MEDIA_KEY), { force: true });
});

describe('buildBookZip', () => {
  it('默认只收录已发布/归档且全家可见的条目', async () => {
    itemFindMany.mockClear();
    await buildBookZip(fakeJob({ options: {} }));
    const where = itemFindMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ['published', 'archived'] });
    expect(where.visibility).toEqual({ in: ['family', 'link'] });
  });

  it('勾选后收录草稿与限阅条目', async () => {
    itemFindMany.mockClear();
    await buildBookZip(fakeJob({ options: { includeDrafts: true, includeRestricted: true } }));
    const where = itemFindMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ['published', 'archived', 'draft'] });
    expect(where.visibility).toEqual({ in: ['family', 'link', 'selected', 'private'] });
  });

  it('生成可离线阅读的书：目录、年代卷、人物卷、索引、条目页、媒体', async () => {
    const result = await buildBookZip(fakeJob({ options: { title: '老张家史册' } }));
    expect(result.items).toBe(1);
    expect(result.chapters).toBe(2); // 1970 年代 + 人物章
    expect(result.media).toBe(1);
    expect(fs.existsSync(result.file)).toBe(true);

    const list = unzipList(result.file);
    for (const expected of [
      'index.html',
      'style.css',
      'README.txt',
      'book.json',
      'chapters/era-1970s.html',
      `chapters/person-${PERSON_ID}.html`,
      `items/${ITEM_ID}.html`,
      'indexes/people.html',
      'indexes/places.html',
      'indexes/tags.html',
      'indexes/categories.html',
      `media/${ITEM_ID}/01-image.webp`,
    ]) {
      expect(list, `ZIP 内应有 ${expected}`).toContain(expected);
    }

    // 目录：三卷齐备，章节可点
    const index = unzipRead(result.file, '*/index.html');
    expect(index).toContain('老张家史册');
    expect(index).toContain('卷一 · 年代志');
    expect(index).toContain('卷二 · 人物志');
    expect(index).toContain('卷三 · 索引');
    expect(index).toContain('chapters/era-1970s.html');

    // 条目页：完整事实 + 原始条目链接 + 时间存疑标注
    const itemPage = unzipRead(result.file, `*/items/${ITEM_ID}.html`);
    expect(itemPage).toContain('外公的樟木箱');
    expect(itemPage).toContain('1978 年');
    expect(itemPage).toContain('时间存疑');
    expect(itemPage).toContain('浙江省 绍兴市 老家堂屋');
    expect(itemPage).toContain('张德山（来源）');
    expect(itemPage).toContain(`/f/${FAMILY_ID}/items/${ITEM_ID}`);
    expect(itemPage).toContain(`media/${ITEM_ID}/01-image.webp`);

    // 人物章：小传与条目卡片
    const personChapter = unzipRead(result.file, `*/chapters/person-${PERSON_ID}.html`);
    expect(personChapter).toContain('一辈子在木器社做活');
    expect(personChapter).toContain('1932—2018');
    expect(personChapter).toContain(`items/${ITEM_ID}.html`);

    // book.json：条目 ↔ 原始链接映射
    const manifest = JSON.parse(unzipRead(result.file, '*/book.json')) as {
      kind: string;
      entries: { id: string; sourceUrl: string }[];
      chapters: { slug: string }[];
    };
    expect(manifest.kind).toBe('family-book');
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.sourceUrl.endsWith(`/f/${FAMILY_ID}/items/${ITEM_ID}`)).toBe(true);
    expect(manifest.chapters.map((c) => c.slug).sort()).toEqual(['era-1970s', `person-${PERSON_ID}`]);
  });

  it('媒体文件缺失时不中断，书中照常生成', async () => {
    itemFindMany.mockResolvedValueOnce([
      { ...itemRow, media: [{ ...mediaRow, storageKey: 'tmp/not-exists.webp' }] },
    ]);
    const result = await buildBookZip(fakeJob({ options: {} }));
    expect(result.media).toBe(0);
    const itemPage = unzipRead(result.file, `*/items/${ITEM_ID}.html`);
    expect(itemPage).toContain('1 个文件在生成时缺失');
  });
});
