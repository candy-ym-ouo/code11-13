import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import {
  buildBookPlan,
  bookBuildSchema,
  entryDisplayOf,
  entrySourceUrl,
  type BookBuildInput,
  type BookEntryInput,
  type BookOptions,
  type BookPersonInput,
} from '@heirloom/shared';
import type { Item, ItemMedia, ItemPerson, Job, Person } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { notFound } from '../http/errors';
import { absOf } from '../storage/local';
import { slugify } from '../utils/crypto';
import { renderBook, type BookEntryModel, type BookMediaRef, type BookModel, type BookPersonModel } from '../book/render';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';
import type { ActorMeta } from './exportService';

/**
 * 家史册：把「已发布 / 已归档 且 全家可见」的条目排版成一本静态书，
 * 按年代（编年卷）与人物（人物卷）编排章节，自动生成目录与索引，
 * 导出为离线可读的 ZIP；每个条目页都保留系统内原始条目的链接。
 */

export async function createBookJob(userId: string, ctx: FamilyContext, input: BookBuildInput, meta: ActorMeta) {
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: 'book_build',
        payload: { requestedBy: userId, options: input } as never,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'book.create',
        targetType: 'job',
        targetId: created.id,
        diff: { options: input },
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
    downloadUrl: job.status === 'done' ? `/api/v1/families/${familyId}/books/${job.id}/download` : null,
    result: job.result,
  };
}

export function bookZipPath(familyId: string, jobId: string): string {
  return path.join(config.EXPORT_ROOT, familyId, `book-${jobId}.zip`);
}

type ItemWithRelations = Item & {
  media: ItemMedia[];
  people: (ItemPerson & { person: Person })[];
  creator: { displayName: string };
};

/**
 * 媒体在书内的存放路径。
 * 原始文件与派生文件（大图/转码）分两个名字空间：同一 sha256 的
 * 「原始 mp3」与「转码 mp3」同名不同内容，直接平铺会互相覆盖。
 */
function bookMediaPath(storageKey: string, variant: 'src' | 'web'): string {
  return `media/${variant}/${path.posix.basename(storageKey)}`;
}

function mediaRefOf(m: ItemMedia, files: Map<string, string>): BookMediaRef | null {
  const use = (key: string | null, variant: 'src' | 'web'): string | null => {
    if (!key) return null;
    if (!files.has(key)) return null;
    return bookMediaPath(key, variant);
  };
  if (m.kind === 'image') {
    const file = use(m.largeKey, 'web') ?? use(m.storageKey, 'src');
    if (!file) return null;
    const thumbFile = use(m.thumbKey, 'web') ?? (m.largeKey ? use(m.largeKey, 'web') : null);
    return { kind: m.kind, file, thumbFile, originalName: m.originalName, caption: m.caption, transcript: null, durationMs: null };
  }
  if (m.kind === 'audio') {
    const file = use(m.transcodeKey, 'web') ?? use(m.storageKey, 'src');
    if (!file) return null;
    return { kind: m.kind, file, thumbFile: null, originalName: m.originalName, caption: m.caption, transcript: m.transcript, durationMs: m.durationMs };
  }
  const file = use(m.storageKey, 'src');
  if (!file) return null;
  return { kind: m.kind, file, thumbFile: null, originalName: m.originalName, caption: m.caption, transcript: null, durationMs: null };
}

/** 收集条目实际引用到的存储 key（去重），并过滤磁盘上已缺失的文件。 */
function collectMediaKeys(items: ItemWithRelations[]): Map<string, string> {
  const keys = new Map<string, string>(); // storageKey → 书内路径
  const consider = (key: string | null, variant: 'src' | 'web') => {
    if (!key || keys.has(key)) return;
    if (!fs.existsSync(absOf(key))) return;
    keys.set(key, bookMediaPath(key, variant));
  };
  for (const item of items) {
    for (const m of item.media) {
      if (m.kind === 'image') {
        consider(m.largeKey, 'web');
        consider(m.thumbKey, 'web');
        // 派生图缺失（处理失败/被清理）时回退到原始文件
        if (!m.largeKey || !keys.has(m.largeKey)) consider(m.storageKey, 'src');
      } else if (m.kind === 'audio') {
        consider(m.transcodeKey, 'web');
        if (!m.transcodeKey || !keys.has(m.transcodeKey)) consider(m.storageKey, 'src');
      } else {
        consider(m.storageKey, 'src');
      }
    }
  }
  return keys;
}

export async function buildBookZip(job: Job): Promise<{ file: string; entries: number; chapters: number; media: number; bytes: number }> {
  const familyId = job.familyId;
  if (!familyId) throw new Error('家史册任务缺少 familyId');

  // 任务载荷在路由层已校验过，这里再解析一次兜底（兼容默认值填充）
  const payload = (job.payload ?? {}) as { options?: unknown };
  const parsed = bookBuildSchema.safeParse(payload.options ?? {});
  if (!parsed.success) throw new Error('家史册任务参数不合法');
  const input = parsed.data;

  const family = await prisma.family.findUniqueOrThrow({ where: { id: familyId } });
  const title = input.title?.trim() || `${family.name}家史册`;
  const options: BookOptions = { title, volumes: input.volumes };

  const items = await prisma.item.findMany({
    where: {
      familyId,
      // 只收录「定稿且全家可见」的内容：草稿、私密条目、指定成员可见的条目不进书
      status: input.includeArchived ? { in: ['published', 'archived'] } : 'published',
      visibility: { in: ['family', 'link'] },
    },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      creator: { select: { displayName: true } },
    },
    orderBy: { sortAt: 'asc' },
  });
  const people = await prisma.person.findMany({
    where: { familyId, deletedAt: null, mergedIntoId: null },
    orderBy: { createdAt: 'asc' },
  });

  const planEntries: BookEntryInput[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    acquiredAt: item.acquiredAt?.toISOString() ?? null,
    acquiredPrecision: item.acquiredPrecision,
    acquiredLabel: item.acquiredLabel,
    sortAt: item.sortAt.toISOString(),
    placeText: item.placeText,
    placeCity: item.placeCity,
    placeProvince: item.placeProvince,
    tags: item.tags,
    people: item.people
      .filter((ip) => ip.person.deletedAt === null && ip.person.mergedIntoId === null)
      .map((ip) => ({ personId: ip.personId, role: ip.role })),
  }));
  const planPeople: BookPersonInput[] = people.map((p) => ({
    id: p.id,
    name: p.name,
    relation: p.relation,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
  }));

  const plan = buildBookPlan(planEntries, planPeople, options);
  const mediaFiles = collectMediaKeys(items);

  const peopleModels: BookPersonModel[] = people.map((p) => ({
    id: p.id,
    name: p.name,
    relation: p.relation,
    birthYear: p.birthYear,
    deathYear: p.deathYear,
    bio: p.bio,
  }));
  const personNameById = new Map(people.map((p) => [p.id, p.name]));

  const entryModels: BookEntryModel[] = items.map((item) => {
    const display = entryDisplayOf({
      id: item.id,
      title: item.title,
      category: item.category,
      acquiredAt: item.acquiredAt?.toISOString() ?? null,
      acquiredPrecision: item.acquiredPrecision,
      acquiredLabel: item.acquiredLabel,
      sortAt: item.sortAt.toISOString(),
      placeText: item.placeText,
      placeCity: item.placeCity,
      placeProvince: item.placeProvince,
      tags: item.tags,
      people: [],
    });
    return {
      id: item.id,
      title: item.title,
      categoryLabel: display.categoryLabel,
      acquiredDisplay: display.acquiredDisplay,
      timeUncertain: display.timeUncertain,
      acquiredNote: item.acquiredNote,
      placeLabel: display.placeLabel,
      storyHtml: item.storyHtml,
      condition: item.condition,
      storageLocation: item.storageLocation,
      tags: item.tags,
      people: item.people
        .filter((ip) => personNameById.has(ip.personId))
        .map((ip) => ({ personId: ip.personId, name: personNameById.get(ip.personId)!, role: ip.role })),
      media: item.media.map((m) => mediaRefOf(m, mediaFiles)).filter((m): m is BookMediaRef => m !== null),
      creatorName: item.creator.displayName,
    };
  });

  const model: BookModel = {
    title,
    familyName: family.name,
    familyId,
    sourceUrl: config.APP_URL,
    generatedAt: new Date(),
    options,
    plan,
    entries: entryModels,
    people: peopleModels,
  };
  const pages = renderBook(model);

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

  const root = `jiashice-${slugify(title, 'book')}-${new Date().toISOString().slice(0, 10)}`;

  for (let i = 0; i < pages.length; i += 1) {
    archive.append(pages[i]!.content, { name: `${root}/${pages[i]!.path}` });
    if (i % 20 === 0) {
      const progress = Math.min(80, Math.round(((i + 1) / pages.length) * 80));
      await prisma.job.update({ where: { id: job.id }, data: { progress } }).catch(() => undefined);
    }
  }

  for (const [key, bookPath] of mediaFiles) {
    archive.file(absOf(key), { name: `${root}/${bookPath}` });
  }

  archive.append(
    JSON.stringify(
      {
        app: '家中物品来历册 · 家史册',
        version: 1,
        generatedAt: model.generatedAt.toISOString(),
        family: { id: family.id, name: family.name },
        title,
        sourceUrl: config.APP_URL,
        options: { volumes: input.volumes, includeArchived: input.includeArchived },
        counts: {
          entries: entryModels.length,
          eraChapters: plan.eraChapters.length,
          personChapters: plan.personChapters.length,
          people: peopleModels.length,
          media: mediaFiles.size,
        },
        entries: entryModels.map((e) => ({
          id: e.id,
          seq: plan.entrySeq[e.id],
          title: e.title,
          file: plan.entryFile[e.id],
          sourceUrl: entrySourceUrl(config.APP_URL, familyId, e.id),
          acquired: e.acquiredDisplay,
          people: e.people.map((p) => p.name),
        })),
      },
      null,
      2,
    ),
    { name: `${root}/book.json` },
  );
  archive.append(
    [
      `《${title}》 · 家史册`,
      '',
      `家庭：${family.name}`,
      `生成时间：${model.generatedAt.toISOString()}`,
      `收录：${entryModels.length} 条（已发布${input.includeArchived ? ' / 已归档' : ''} 且 全家可见 的条目）`,
      '',
      '如何阅读：',
      '1. 解压后用浏览器打开 index.html，从总目录进入各章节。',
      '2. 编年卷按年代分章，人物卷按人物分章；条目索引 / 人物索引 / 地点索引在 index/ 目录。',
      '3. 全部页面与媒体都在本包内，离线可完整阅读、播放。',
      '4. 每个条目页末尾都有「系统原始条目」链接，联网时可回到系统查看最新版本；',
      '   全部链接也汇总在 book.json 的 entries 字段里。',
      '5. 想打印或转 PDF：在浏览器里直接打印，章节会自动分页。',
      '',
      '说明：本书是生成时刻的静态快照，之后在系统里的修改不会自动同步，重新生成即可。',
    ].join('\n'),
    { name: `${root}/README.txt` },
  );

  await prisma.job.update({ where: { id: job.id }, data: { progress: 90 } }).catch(() => undefined);
  await archive.finalize();
  await done;

  const stat = await fsp.stat(outPath);
  const chapters = plan.eraChapters.length + plan.personChapters.length;
  logger.info(
    { jobId: job.id, entries: entryModels.length, chapters, media: mediaFiles.size, bytes: stat.size },
    '家史册生成完成',
  );
  return { file: outPath, entries: entryModels.length, chapters, media: mediaFiles.size, bytes: stat.size };
}
