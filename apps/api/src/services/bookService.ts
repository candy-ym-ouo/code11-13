import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import {
  CATEGORY_LABELS,
  PERSON_ROLE_LABELS,
  buildCategoryIndex,
  buildPeopleIndex,
  buildPlaceIndex,
  buildTagIndex,
  excerptOf,
  formatAcquired,
  isTimeUncertain,
  planEraChapters,
  planPersonChapters,
} from '@heirloom/shared';
import type { BookBuildInput, BookChapter, BookEntry, BookIndexGroup, BookPerson } from '@heirloom/shared';
import type { Item, ItemMedia, ItemPerson, Job, Person, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { notFound } from '../http/errors';
import { absOf, extensionFor } from '../storage/local';
import { slugify } from '../utils/crypto';
import { escapeHtml as esc } from '../utils/sanitize';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createBookJob(userId: string, ctx: FamilyContext, options: BookBuildInput, meta: ActorMeta) {
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: 'book_build',
        payload: { requestedBy: userId, options } as never,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'book.create',
        targetType: 'job',
        targetId: created.id,
        diff: { options } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });
  return { jobId: job.id, status: job.status };
}

export async function getBookJob(familyId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, familyId, type: 'book_build' } });
  if (!job) throw notFound('家史册任务不存在');
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    lastError: job.lastError,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    downloadUrl: job.status === 'done' ? `/api/v1/families/${familyId}/book/${job.id}/download` : null,
    result: job.result,
  };
}

export function bookZipPath(familyId: string, jobId: string): string {
  return path.join(config.EXPORT_ROOT, familyId, `book-${jobId}.zip`);
}

/* ------------------------------------------------------------------ */
/* 排版：静态 HTML                                                     */
/* ------------------------------------------------------------------ */

/**
 * 书的样式。目标是「双击 index.html 就像翻开一本书」：
 * 衬线字体、限宽栏、章节题花，打印时隐藏导航。
 */
const BOOK_CSS = `:root {
  --ink: #2b2620;
  --ink-soft: #6b6257;
  --paper: #faf7f1;
  --card: #fffdf9;
  --line: #e3dccd;
  --accent: #8a5a2b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif;
  line-height: 1.8;
}
.topbar {
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  max-width: 760px; margin: 0 auto; padding: 14px 20px;
  font-size: 14px; color: var(--ink-soft);
  border-bottom: 1px solid var(--line);
}
.topbar a { color: var(--accent); text-decoration: none; }
main { max-width: 760px; margin: 0 auto; padding: 24px 20px 64px; }
a { color: var(--accent); }
.cover { text-align: center; padding: 64px 0 40px; border-bottom: 3px double var(--line); }
.cover h1 { font-size: 40px; letter-spacing: 0.12em; margin: 0 0 12px; }
.cover .sub { color: var(--ink-soft); font-size: 15px; }
.cover .counts { margin-top: 20px; font-size: 14px; color: var(--ink-soft); }
h1 { font-size: 30px; letter-spacing: 0.06em; }
h2 { font-size: 22px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h2 .count { font-size: 14px; color: var(--ink-soft); font-weight: normal; margin-left: 8px; }
.toc { list-style: none; padding: 0; margin: 0; }
.toc li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 4px; border-bottom: 1px dotted var(--line); }
.toc .meta { color: var(--ink-soft); font-size: 13px; white-space: nowrap; }
.chapter-head { text-align: center; padding: 40px 0 24px; }
.chapter-head .volume { font-size: 13px; letter-spacing: 0.3em; color: var(--ink-soft); }
.chapter-head h1 { margin: 8px 0 4px; }
.chapter-head .sub { color: var(--ink-soft); }
.bio { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 18px; font-size: 15px; }
.entry-card {
  display: flex; gap: 16px; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 14px 16px; margin: 14px 0;
}
.entry-card__cover { flex: 0 0 96px; }
.entry-card__cover img { width: 96px; height: 96px; object-fit: cover; border-radius: 6px; display: block; }
.entry-card h3 { margin: 0 0 4px; font-size: 18px; }
.entry-card h3 a { color: var(--ink); text-decoration: none; }
.entry-card h3 a:hover { color: var(--accent); }
.meta { color: var(--ink-soft); font-size: 13.5px; margin: 2px 0; }
.excerpt { margin: 6px 0 0; font-size: 15px; color: #453e34; }
.flag {
  display: inline-block; font-size: 12px; color: #8a5a2b;
  border: 1px solid #d9c39a; border-radius: 4px; padding: 0 5px; margin-left: 4px;
  vertical-align: 1px;
}
.facts { display: grid; grid-template-columns: 88px 1fr; gap: 4px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 14px 18px; font-size: 15px; }
.facts dt { color: var(--ink-soft); }
.facts dd { margin: 0; }
.story { margin: 24px 0; font-size: 16.5px; }
.story blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--line); color: var(--ink-soft); }
figure { margin: 18px 0; text-align: center; }
figure img { max-width: 100%; border-radius: 6px; border: 1px solid var(--line); }
figcaption { font-size: 13px; color: var(--ink-soft); margin-top: 6px; }
audio { width: 100%; margin: 8px 0; }
.transcript { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; font-size: 14px; color: var(--ink-soft); white-space: pre-wrap; }
.doc-link { display: inline-block; margin: 4px 12px 4px 0; }
.source-note {
  margin-top: 40px; padding: 14px 18px; font-size: 13.5px; color: var(--ink-soft);
  background: var(--card); border: 1px dashed var(--line); border-radius: 8px;
  word-break: break-all;
}
.index-group ul { list-style: none; padding: 0; margin: 0; }
.index-group li { padding: 6px 4px; border-bottom: 1px dotted var(--line); display: flex; justify-content: space-between; gap: 12px; }
.book-footer { max-width: 760px; margin: 0 auto; padding: 18px 20px 40px; font-size: 12.5px; color: var(--ink-soft); border-top: 1px solid var(--line); }
.breadcrumb { font-size: 13.5px; color: var(--ink-soft); margin-bottom: 8px; }
.breadcrumb a { color: var(--ink-soft); }
.empty-note { color: var(--ink-soft); text-align: center; padding: 40px 0; }
@media print {
  .topbar, .breadcrumb { display: none; }
  body { background: #fff; }
}
`;

interface PageOptions {
  title: string;
  /** 相对书根的前缀：根页面 ''，chapters/items/indexes 下为 '../' */
  root: string;
  bookTitle: string;
  body: string;
}

function page({ title, root, bookTitle, body }: PageOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(bookTitle)}</title>
<link rel="stylesheet" href="${root}style.css">
</head>
<body>
<nav class="topbar"><a href="${root}index.html">⟨ 目录</a><span>${esc(bookTitle)}</span></nav>
<main>
${body}
</main>
<footer class="book-footer">本册由「家中物品来历册」自动生成，可离线翻阅；每条末尾的「原始条目」链接指向运行中的系统，需联网且系统在线时才能打开。</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* 数据装配                                                            */
/* ------------------------------------------------------------------ */

type ItemRow = Item & {
  media: ItemMedia[];
  people: (ItemPerson & { person: Person })[];
  creator: { displayName: string };
};

function placeOf(item: Item): string | null {
  const text = [item.placeProvince, item.placeCity, item.placeText].filter(Boolean).join(' ');
  return text || null;
}

function toEntry(item: ItemRow): BookEntry {
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    acquiredDisplay: formatAcquired({
      acquiredAt: item.acquiredAt,
      acquiredPrecision: item.acquiredPrecision,
      acquiredLabel: item.acquiredLabel,
    }),
    timeUncertain: isTimeUncertain({ acquiredPrecision: item.acquiredPrecision }),
    timeUnknown: item.acquiredPrecision === 'unknown' || !item.acquiredAt,
    sortAt: item.sortAt.toISOString(),
    place: placeOf(item),
    tags: item.tags,
    people: item.people.map((link) => ({ personId: link.person.id, name: link.person.name, role: link.role })),
    excerpt: excerptOf(item.storyText),
  };
}

/** 一件条目要随书带出的媒体文件。文件名只用 ASCII，避免 Windows 解压中文名乱码。 */
interface PlannedMedia {
  copies: { abs: string; zip: string }[];
  images: { zip: string; caption: string | null }[];
  audios: { zip: string; caption: string | null; transcript: string | null; name: string }[];
  docs: { zip: string; name: string; bytes: number }[];
  missing: number;
}

function planMedia(item: ItemRow): PlannedMedia {
  const plan: PlannedMedia = { copies: [], images: [], audios: [], docs: [], missing: 0 };
  item.media.forEach((m, idx) => {
    // 图片带大尺寸 WebP、音频带 mp3 转码，体积比原始文件小得多；拿不到才回退原文件
    const key = m.kind === 'image' ? m.largeKey ?? m.storageKey : m.kind === 'audio' ? m.transcodeKey ?? m.storageKey : m.storageKey;
    const ext = key === m.storageKey ? extensionFor(m.mimeType) : key.endsWith('.mp3') ? 'mp3' : 'webp';
    const zip = `media/${item.id}/${String(idx + 1).padStart(2, '0')}-${m.kind}.${ext}`;
    const abs = absOf(key);
    if (!fs.existsSync(abs)) {
      plan.missing += 1;
      return;
    }
    plan.copies.push({ abs, zip });
    if (m.kind === 'image') plan.images.push({ zip, caption: m.caption });
    else if (m.kind === 'audio') plan.audios.push({ zip, caption: m.caption, transcript: m.transcript, name: m.originalName });
    else plan.docs.push({ zip, name: m.originalName, bytes: Number(m.byteSize) });
  });
  return plan;
}

/* ------------------------------------------------------------------ */
/* 页面渲染                                                            */
/* ------------------------------------------------------------------ */

function entryCard(entry: BookEntry, cover: string | null, root: string): string {
  const href = `${root}items/${entry.id}.html`;
  return `<article class="entry-card">
${cover ? `<a class="entry-card__cover" href="${href}"><img src="${cover}" alt="" loading="lazy"></a>` : ''}
<div>
<h3><a href="${href}">${esc(entry.title)}</a></h3>
<p class="meta">${esc(entry.acquiredDisplay)}${entry.timeUncertain ? '<span class="flag">时间存疑</span>' : ''}${entry.place ? ` · ${esc(entry.place)}` : ''}</p>
${entry.excerpt ? `<p class="excerpt">${esc(entry.excerpt)}</p>` : ''}
</div>
</article>`;
}

function renderChapter(
  chapter: BookChapter,
  volumeLabel: string,
  entriesById: Map<string, BookEntry>,
  mediaByItem: Map<string, PlannedMedia>,
  bookTitle: string,
  extraHead = '',
): string {
  const cards = chapter.entryIds
    .map((id) => {
      const entry = entriesById.get(id);
      if (!entry) return '';
      const firstImage = mediaByItem.get(id)?.images[0]?.zip ?? null;
      return entryCard(entry, firstImage ? `../${firstImage}` : null, '../');
    })
    .join('\n');
  return page({
    title: chapter.title,
    root: '../',
    bookTitle,
    body: `<header class="chapter-head">
<div class="volume">${esc(volumeLabel)}</div>
<h1>${esc(chapter.title)}</h1>
${chapter.subtitle ? `<div class="sub">${esc(chapter.subtitle)}</div>` : ''}
<p class="meta">共 ${chapter.entryIds.length} 条</p>
</header>
${extraHead}
${cards || '<p class="empty-note">本章暂无条目。</p>'}`,
  });
}

function renderItemPage(
  entry: BookEntry,
  item: ItemRow,
  media: PlannedMedia,
  chaptersOfItem: BookChapter[],
  peopleWithChapters: Set<string>,
  sourceUrl: string,
  bookTitle: string,
): string {
  const crumbs = chaptersOfItem
    .map((c) => `<a href="../chapters/${c.slug}.html">${esc(c.title)}</a>`)
    .join(' · ');
  const peopleLine = entry.people
    .map((p) => {
      const label = `${p.name}（${PERSON_ROLE_LABELS[p.role]}）`;
      return peopleWithChapters.has(p.personId) ? `<a href="../chapters/person-${p.personId}.html">${esc(label)}</a>` : esc(label);
    })
    .join('、');
  const facts: [string, string][] = [
    ['获得时间', `${esc(entry.acquiredDisplay)}${item.acquiredNote ? `（${esc(item.acquiredNote)}）` : ''}${entry.timeUncertain ? ' <span class="flag">时间存疑</span>' : ''}`],
    ['地点', entry.place ? esc(entry.place) : '未记录'],
    ['分类', esc(CATEGORY_LABELS[entry.category])],
    ['相关人物', peopleLine || '未记录'],
    ['标签', entry.tags.length ? entry.tags.map((t) => `#${esc(t)}`).join(' ') : '无'],
    ['保存状况', item.condition ? esc(item.condition) : '未记录'],
    ['存放位置', item.storageLocation ? esc(item.storageLocation) : '未记录'],
    ['记录者', esc(item.creator.displayName)],
  ];

  const images = media.images
    .map(
      (img) => `<figure><img src="../${img.zip}" alt="${esc(img.caption ?? entry.title)}" loading="lazy">${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}</figure>`,
    )
    .join('\n');
  const audios = media.audios
    .map(
      (a) => `<figure>
<audio controls preload="none" src="../${a.zip}"></audio>
<figcaption>${esc(a.caption ?? a.name)}</figcaption>
${a.transcript ? `<div class="transcript">${esc(a.transcript)}</div>` : ''}
</figure>`,
    )
    .join('\n');
  const docs = media.docs
    .map((d) => `<a class="doc-link" href="../${d.zip}">📄 ${esc(d.name)}（${(d.bytes / 1024).toFixed(0)} KB）</a>`)
    .join('\n');
  const mediaSections = [
    images ? `<h2>图片</h2>\n${images}` : '',
    audios ? `<h2>录音</h2>\n${audios}` : '',
    docs ? `<h2>文件</h2>\n${docs}` : '',
    media.missing > 0 ? `<p class="meta">有 ${media.missing} 个文件在生成时缺失，未收入本册。</p>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return page({
    title: entry.title,
    root: '../',
    bookTitle,
    body: `<nav class="breadcrumb"><a href="../index.html">目录</a>${crumbs ? ` / ${crumbs}` : ''}</nav>
<h1>${esc(entry.title)}</h1>
<dl class="facts">
${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('\n')}
</dl>
${item.storyHtml ? `<section class="story">${item.storyHtml}</section>` : ''}
${mediaSections}
<footer class="source-note">
原始条目：<a href="${esc(sourceUrl)}">${esc(sourceUrl)}</a><br>
条目编号：${esc(entry.id)} · 收录于 ${new Date().toISOString().slice(0, 10)}
</footer>`,
  });
}

function renderIndexPage(
  title: string,
  groups: BookIndexGroup[],
  entriesById: Map<string, BookEntry>,
  bookTitle: string,
): string {
  const body = groups
    .map((group) => {
      const rows = group.entryIds
        .map((id) => {
          const entry = entriesById.get(id);
          if (!entry) return '';
          return `<li><a href="../items/${entry.id}.html">${esc(entry.title)}</a><span class="meta">${esc(entry.acquiredDisplay)}</span></li>`;
        })
        .join('\n');
      return `<section class="index-group"><h2>${esc(group.label)}<span class="count">${group.entryIds.length} 条</span></h2><ul>${rows}</ul></section>`;
    })
    .join('\n');
  return page({
    title,
    root: '../',
    bookTitle,
    body: `<h1>${esc(title)}</h1>\n${body || '<p class="empty-note">暂无可索引的内容。</p>'}`,
  });
}

/* ------------------------------------------------------------------ */
/* 生成 ZIP                                                            */
/* ------------------------------------------------------------------ */

export interface BookBuildResult {
  file: string;
  items: number;
  chapters: number;
  media: number;
  bytes: number;
}

/**
 * 生成家史册静态包。产物结构：
 * index.html（封面+目录）/ chapters（年代卷+人物卷）/ items（条目页，含原始条目链接）/
 * indexes（人物/地点/标签/分类索引）/ media / book.json / README.txt。
 * 全部相对链接，双击 index.html 即可离线阅读。
 */
export async function buildBookZip(job: Job): Promise<BookBuildResult> {
  const familyId = job.familyId;
  if (!familyId) throw new Error('家史册任务缺少 familyId');
  const options = ((job.payload as { options?: Partial<BookBuildInput> } | null)?.options ?? {}) as Partial<BookBuildInput>;

  const family = await prisma.family.findUniqueOrThrow({ where: { id: familyId } });
  const bookTitle = options.title?.trim() || `${family.name} · 家史册`;

  const statuses = options.includeDrafts ? (['published', 'archived', 'draft'] as const) : (['published', 'archived'] as const);
  const visibilities = options.includeRestricted
    ? (['family', 'link', 'selected', 'private'] as const)
    : (['family', 'link'] as const);

  const [peopleRows, itemRows] = await Promise.all([
    prisma.person.findMany({ where: { familyId, deletedAt: null, mergedIntoId: null }, orderBy: { name: 'asc' } }),
    prisma.item.findMany({
      where: { familyId, status: { in: [...statuses] }, visibility: { in: [...visibilities] } },
      include: {
        media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
        people: { include: { person: true } },
        creator: { select: { displayName: true } },
      },
      orderBy: { sortAt: 'asc' },
    }),
  ]);

  const people: BookPerson[] = peopleRows.map((p) => ({
    id: p.id,
    name: p.name,
    relation: p.relation,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
    bio: p.bio,
  }));
  const entries = itemRows.map(toEntry);
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const itemRowById = new Map(itemRows.map((i) => [i.id, i]));

  // 编排：年代卷 → 人物卷 → 四种索引，全部由共享层的纯函数完成
  const eraChapters = planEraChapters(entries);
  const personChapters = planPersonChapters(entries, people);
  const allChapters = [...eraChapters, ...personChapters];
  const peopleIndex = buildPeopleIndex(entries, people);
  const placeIndex = buildPlaceIndex(entries);
  const tagIndex = buildTagIndex(entries);
  const categoryIndex = buildCategoryIndex(entries);

  const chaptersOfItem = new Map<string, BookChapter[]>();
  for (const chapter of allChapters) {
    for (const id of chapter.entryIds) {
      const list = chaptersOfItem.get(id) ?? [];
      list.push(chapter);
      chaptersOfItem.set(id, list);
    }
  }
  const peopleWithChapters = new Set(personChapters.map((c) => c.slug.replace(/^person-/, '')));

  const outPath = bookZipPath(familyId, job.id);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
    output.on('error', reject);
  });
  archive.pipe(output);

  const root = `book-${slugify(family.name)}-${new Date().toISOString().slice(0, 10)}`;
  const add = (name: string, content: string) => archive.append(content, { name: `${root}/${name}` });

  add('style.css', BOOK_CSS);

  // 媒体随书计划（每条一次，条目页与章节卡片共用）
  const mediaByItem = new Map(itemRows.map((item) => [item.id, planMedia(item)]));

  // 条目页 + 媒体
  let mediaCount = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const item = itemRowById.get(entry.id)!;
    const media = mediaByItem.get(entry.id)!;
    for (const copy of media.copies) {
      archive.file(copy.abs, { name: `${root}/${copy.zip}` });
      mediaCount += 1;
    }
    const sourceUrl = `${config.APP_URL}/f/${familyId}/items/${entry.id}`;
    add(
      `items/${entry.id}.html`,
      renderItemPage(entry, item, media, chaptersOfItem.get(entry.id) ?? [], peopleWithChapters, sourceUrl, bookTitle),
    );
    if (i % 20 === 0 || i === entries.length - 1) {
      const progress = entries.length === 0 ? 70 : Math.min(70, Math.round(((i + 1) / entries.length) * 70));
      await prisma.job.update({ where: { id: job.id }, data: { progress } }).catch(() => undefined);
    }
  }

  // 章节页
  for (const chapter of eraChapters) {
    add(`chapters/${chapter.slug}.html`, renderChapter(chapter, '卷一 · 年代志', entriesById, mediaByItem, bookTitle));
  }
  const personById = new Map(people.map((p) => [p.id, p]));
  for (const chapter of personChapters) {
    const person = personById.get(chapter.slug.replace(/^person-/, ''));
    const bio = person?.bio ? `<div class="bio">${esc(person.bio)}</div>` : '';
    add(
      `chapters/${chapter.slug}.html`,
      renderChapter(chapter, '卷二 · 人物志', entriesById, mediaByItem, bookTitle, bio),
    );
  }

  // 索引页
  add('indexes/people.html', renderIndexPage('人物索引', peopleIndex, entriesById, bookTitle));
  add('indexes/places.html', renderIndexPage('地点索引', placeIndex, entriesById, bookTitle));
  add('indexes/tags.html', renderIndexPage('标签索引', tagIndex, entriesById, bookTitle));
  add('indexes/categories.html', renderIndexPage('分类索引', categoryIndex, entriesById, bookTitle));

  // 封面 + 目录
  const tocChapter = (c: BookChapter) =>
    `<li><a href="chapters/${c.slug}.html">${esc(c.title)}</a><span class="meta">${c.entryIds.length} 条</span></li>`;
  add(
    'index.html',
    page({
      title: '目录',
      root: '',
      bookTitle,
      body: `<header class="cover">
<h1>${esc(bookTitle)}</h1>
<div class="sub">${esc(family.name)} · ${new Date().toISOString().slice(0, 10)} 辑录</div>
<div class="counts">共 ${entries.length} 条 · ${allChapters.length} 章 · ${mediaCount} 个媒体文件</div>
</header>
<h2>卷一 · 年代志</h2>
<ul class="toc">${eraChapters.map(tocChapter).join('\n') || '<li><span class="meta">暂无</span></li>'}</ul>
<h2>卷二 · 人物志</h2>
<ul class="toc">${personChapters.map(tocChapter).join('\n') || '<li><span class="meta">暂无</span></li>'}</ul>
<h2>卷三 · 索引</h2>
<ul class="toc">
<li><a href="indexes/people.html">人物索引</a><span class="meta">${peopleIndex.length} 人</span></li>
<li><a href="indexes/places.html">地点索引</a><span class="meta">${placeIndex.length} 处</span></li>
<li><a href="indexes/tags.html">标签索引</a><span class="meta">${tagIndex.length} 个</span></li>
<li><a href="indexes/categories.html">分类索引</a><span class="meta">${categoryIndex.length} 类</span></li>
</ul>`,
    }),
  );

  // 机器可读清单：条目 → 原始链接 的映射留在这里，供将来回导或校验
  add(
    'book.json',
    JSON.stringify(
      {
        app: '家中物品来历册',
        kind: 'family-book',
        version: 1,
        generatedAt: new Date().toISOString(),
        family: { id: family.id, name: family.name },
        title: bookTitle,
        options: {
          includeDrafts: Boolean(options.includeDrafts),
          includeRestricted: Boolean(options.includeRestricted),
        },
        sourceBaseUrl: config.APP_URL,
        counts: { entries: entries.length, chapters: allChapters.length, media: mediaCount },
        chapters: allChapters.map((c) => ({ ...c, file: `chapters/${c.slug}.html` })),
        entries: entries.map((e) => ({
          id: e.id,
          title: e.title,
          file: `items/${e.id}.html`,
          sourceUrl: `${config.APP_URL}/f/${familyId}/items/${e.id}`,
        })),
      },
      null,
      2,
    ),
  );

  add(
    'README.txt',
    [
      `《${bookTitle}》—— 家史册静态版`,
      '',
      `家庭：${family.name}`,
      `生成时间：${new Date().toISOString()}`,
      `收录：${entries.length} 条 · ${allChapters.length} 章 · ${mediaCount} 个媒体文件`,
      '',
      '如何阅读：',
      '1. 解压后双击 index.html，从目录开始翻阅；全部页面都是相对链接，离线可读。',
      '2. 卷一按年代分章，卷二按人物分章，卷三是人物/地点/标签/分类索引。',
      '3. 每个条目页底部都有「原始条目」链接，指向运行中的系统（需联网且系统在线）。',
      '4. book.json 是机器可读清单，保存了条目与原始链接的对应关系。',
      '',
      '本册不依赖本系统即可阅读；原始条目链接在系统在线时可用。',
    ].join('\n'),
  );

  await archive.finalize();
  await done;

  const stat = await fsp.stat(outPath);
  logger.info(
    { jobId: job.id, items: entries.length, chapters: allChapters.length, media: mediaCount, bytes: stat.size },
    '家史册生成完成',
  );
  return { file: outPath, items: entries.length, chapters: allChapters.length, media: mediaCount, bytes: stat.size };
}
