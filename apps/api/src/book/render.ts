import {
  BOOK_VOLUME_LABELS,
  entryFileName,
  entrySourceUrl,
  eraFileName,
  personFileName,
  personYearsOf,
  type BookOptions,
  type BookPlan,
  type MediaKind,
  type PersonRole,
} from '@heirloom/shared';
import { PERSON_ROLE_LABELS } from '@heirloom/shared';
import { escapeHtml } from '../utils/sanitize';

/**
 * 家史册静态站点渲染器。
 * 输入是一份自包含的书册模型（bookService 从数据库装配），
 * 输出一组「相对路径 → HTML 内容」的页面，全部离线可读：
 * 不引用任何外部资源，样式只有一个 assets/book.css。
 */

export interface BookMediaRef {
  kind: MediaKind;
  /** 书内相对路径，如 media/<sha>-lg.webp */
  file: string;
  /** 列表页用的小图（可选） */
  thumbFile: string | null;
  originalName: string;
  caption: string | null;
  transcript: string | null;
  durationMs: number | null;
}

export interface BookEntryModel {
  id: string;
  title: string;
  categoryLabel: string;
  acquiredDisplay: string;
  timeUncertain: boolean;
  acquiredNote: string | null;
  placeLabel: string | null;
  storyHtml: string | null;
  condition: string | null;
  storageLocation: string | null;
  tags: string[];
  people: { personId: string; name: string; role: PersonRole }[];
  media: BookMediaRef[];
  creatorName: string;
}

export interface BookPersonModel {
  id: string;
  name: string;
  relation: string | null;
  birthYear: number | null;
  deathYear: number | null;
  bio: string | null;
}

export interface BookModel {
  title: string;
  familyName: string;
  familyId: string;
  /** 系统访问地址：条目页保留的「原始条目」链接指向它 */
  sourceUrl: string;
  generatedAt: Date;
  options: BookOptions;
  plan: BookPlan;
  entries: BookEntryModel[];
  people: BookPersonModel[];
}

export interface BookPage {
  path: string;
  content: string;
}

const CSS_PATH = 'assets/book.css';

/** 书册样式：书卷气（衬线、暖纸色），屏幕与打印两用；打印时每章另起一页。 */
export const BOOK_CSS = `:root {
  --paper: #faf6ef;
  --ink: #2b2620;
  --ink-soft: #6b6257;
  --accent: #8c3f2b;
  --line: #e3d9c8;
  --card: #fffdf8;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif;
  line-height: 1.8;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.book-nav {
  display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline;
  max-width: 880px; margin: 0 auto; padding: 14px 20px;
  border-bottom: 1px solid var(--line); font-size: 14px;
}
.book-nav__title { font-weight: 700; margin-right: auto; color: var(--ink); }
.book-nav a { color: var(--ink-soft); }
.book-nav a:hover { color: var(--accent); }
.page { max-width: 880px; margin: 0 auto; padding: 28px 20px 64px; }
.cover { text-align: center; padding: 72px 20px 40px; }
.cover__mark { font-size: 15px; letter-spacing: 0.5em; color: var(--ink-soft); }
.cover h1 { font-size: 40px; margin: 18px 0 8px; letter-spacing: 0.08em; }
.cover__family { font-size: 17px; color: var(--ink-soft); }
.cover__meta { margin-top: 26px; font-size: 13px; color: var(--ink-soft); }
.toc { max-width: 640px; margin: 0 auto; }
.toc h2, .chapter-title {
  font-size: 20px; letter-spacing: 0.2em; color: var(--accent);
  border-bottom: 1px solid var(--line); padding-bottom: 8px; margin: 40px 0 16px;
}
.toc ol { margin: 0; padding-left: 1.6em; }
.toc li { margin: 6px 0; }
.toc__count { color: var(--ink-soft); font-size: 13px; margin-left: 8px; }
.chapter-head { text-align: center; padding: 40px 0 8px; }
.chapter-head__kicker { font-size: 13px; letter-spacing: 0.4em; color: var(--ink-soft); }
.chapter-head h1 { font-size: 32px; margin: 10px 0 6px; }
.chapter-head__sub { color: var(--ink-soft); font-size: 14px; }
.entry-card {
  display: flex; gap: 16px; align-items: flex-start;
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 16px; margin: 12px 0;
}
.entry-card__thumb { width: 72px; height: 72px; object-fit: cover; border-radius: 6px; flex: none; }
.entry-card__body { min-width: 0; }
.entry-card__title { font-size: 17px; font-weight: 700; }
.entry-card__title .seq { color: var(--ink-soft); font-weight: 400; margin-right: 8px; }
.entry-card__meta { font-size: 13px; color: var(--ink-soft); margin-top: 2px; }
.entry-card__excerpt { font-size: 14px; color: var(--ink); margin-top: 6px; }
.entry__head { border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 18px; }
.entry__seq { font-size: 13px; letter-spacing: 0.3em; color: var(--ink-soft); }
.entry__head h1 { font-size: 30px; margin: 6px 0 10px; }
.meta-table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 0 0 18px; }
.meta-table th, .meta-table td { text-align: left; padding: 6px 10px; border-bottom: 1px dashed var(--line); vertical-align: top; }
.meta-table th { width: 96px; color: var(--ink-soft); font-weight: 400; white-space: nowrap; }
.story { font-size: 16px; }
.story blockquote { margin: 12px 0; padding: 4px 16px; border-left: 3px solid var(--line); color: var(--ink-soft); }
.uncertain { color: var(--accent); font-size: 12px; border: 1px solid var(--accent); border-radius: 4px; padding: 0 5px; margin-left: 6px; }
.media-figure { margin: 18px 0; }
.media-figure img { max-width: 100%; border-radius: 8px; border: 1px solid var(--line); display: block; }
.media-figure figcaption { font-size: 13px; color: var(--ink-soft); margin-top: 6px; }
.media-audio { margin: 14px 0; }
.media-audio audio { width: 100%; }
.transcript { font-size: 14px; color: var(--ink-soft); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-top: 8px; white-space: pre-wrap; }
.media-doc { display: inline-block; margin: 6px 12px 6px 0; padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font-size: 14px; }
.tag-row { margin: 14px 0 0; font-size: 13px; color: var(--ink-soft); }
.tag-row span { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 10px; margin: 0 6px 6px 0; }
.entry__source {
  margin-top: 36px; padding: 14px 16px; font-size: 13px; color: var(--ink-soft);
  background: var(--card); border: 1px dashed var(--line); border-radius: 8px; word-break: break-all;
}
.pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 28px; font-size: 14px; }
.index-list { list-style: none; margin: 0; padding: 0; }
.index-list li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 2px; border-bottom: 1px dashed var(--line); font-size: 15px; }
.index-list .meta { color: var(--ink-soft); font-size: 13px; white-space: nowrap; }
.person-head { text-align: center; padding: 36px 0 6px; }
.person-head h1 { font-size: 30px; margin: 8px 0 4px; }
.person-head__years { color: var(--ink-soft); font-size: 14px; }
.person-bio { max-width: 640px; margin: 14px auto 0; color: var(--ink); font-size: 15px; white-space: pre-wrap; }
.role-group { margin: 22px 0 6px; font-size: 15px; color: var(--accent); letter-spacing: 0.15em; }
.book-footer { max-width: 880px; margin: 0 auto; padding: 22px 20px 40px; border-top: 1px solid var(--line); font-size: 12px; color: var(--ink-soft); }
@media (max-width: 560px) {
  .cover h1 { font-size: 30px; }
  .entry-card__thumb { width: 56px; height: 56px; }
}
@media print {
  body { background: #fff; }
  .book-nav, .pager { display: none; }
  .chapter, .entry-page, .person-page { break-before: page; }
  a { color: inherit; text-decoration: none; }
  .entry__source { border: 1px solid #999; }
}
`;

function esc(value: string | null | undefined): string {
  return value ? escapeHtml(value) : '';
}

/** 页面深度 → 回到书根的相对前缀（根目录 ''，子目录 '../'）。 */
function rootPrefix(path: string): string {
  const depth = path.split('/').length - 1;
  return depth <= 0 ? './' : '../'.repeat(depth);
}

function href(from: string, to: string): string {
  return `${rootPrefix(from)}${to}`;
}

function shell(pagePath: string, model: BookModel, active: 'home' | 'era' | 'person' | 'index', title: string, body: string): string {
  const home = href(pagePath, 'index.html');
  const nav: string[] = [`<a class="book-nav__title" href="${home}">${esc(model.title)}</a>`];
  if (model.options.volumes.includes('era')) {
    const first = model.plan.eraChapters[0];
    nav.push(`<a href="${first ? href(pagePath, eraFileName(first.key)) : `${home}#toc-era`}"${active === 'era' ? ' aria-current="page"' : ''}>${BOOK_VOLUME_LABELS.era}</a>`);
  }
  if (model.options.volumes.includes('person')) {
    const first = model.plan.personChapters[0];
    nav.push(`<a href="${first ? href(pagePath, personFileName(first.personId)) : `${home}#toc-person`}"${active === 'person' ? ' aria-current="page"' : ''}>${BOOK_VOLUME_LABELS.person}</a>`);
  }
  nav.push(`<a href="${href(pagePath, 'index/entries.html')}"${active === 'index' ? ' aria-current="page"' : ''}>索引</a>`);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(model.title)}</title>
<link rel="stylesheet" href="${href(pagePath, CSS_PATH)}">
</head>
<body>
<nav class="book-nav">${nav.join('')}</nav>
${body}
<footer class="book-footer">
  《${esc(model.title)}》 · ${esc(model.familyName)} · 生成于 ${esc(formatDateTime(model.generatedAt))}<br>
  本册为离线静态副本，内容以系统内原始条目为准；联网时可通过各条目页末尾的链接回到系统查看最新版本。
</footer>
</body>
</html>`;
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()} 年 ${pad(d.getMonth() + 1)} 月 ${pad(d.getDate())} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function excerptOf(entry: BookEntryModel, max = 72): string {
  const text = (entry.storyHtml ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function thumbOf(entry: BookEntryModel): string | null {
  const img = entry.media.find((m) => m.kind === 'image');
  return img ? (img.thumbFile ?? img.file) : null;
}

function entryCard(pagePath: string, model: BookModel, entry: BookEntryModel): string {
  const plan = model.plan;
  const file = plan.entryFile[entry.id]!;
  const seq = plan.entrySeq[entry.id]!;
  const thumb = thumbOf(entry);
  const meta = [entry.acquiredDisplay, entry.placeLabel].filter(Boolean).join(' · ');
  const excerpt = excerptOf(entry);
  return `<div class="entry-card">
  ${thumb ? `<img class="entry-card__thumb" src="${href(pagePath, thumb)}" alt="" loading="lazy">` : ''}
  <div class="entry-card__body">
    <div class="entry-card__title"><a href="${href(pagePath, file)}"><span class="seq">${String(seq).padStart(3, '0')}</span>${esc(entry.title)}</a></div>
    <div class="entry-card__meta">${esc(meta)}${entry.timeUncertain ? '<span class="uncertain">时间存疑</span>' : ''}</div>
    ${excerpt ? `<div class="entry-card__excerpt">${esc(excerpt)}</div>` : ''}
  </div>
</div>`;
}

// ---------- 封面 + 总目录 ----------

function renderCover(model: BookModel): string {
  const { plan } = model;
  const eraToc = plan.eraChapters
    .map((c) => `<li><a href="${eraFileName(c.key)}">${esc(c.title)}</a><span class="toc__count">${c.entryIds.length} 条</span></li>`)
    .join('');
  const peopleById = new Map(model.people.map((p) => [p.id, p]));
  const personToc = plan.personChapters
    .map((c) => {
      const p = peopleById.get(c.personId);
      if (!p) return '';
      const years = personYearsOf(p);
      return `<li><a href="${personFileName(c.personId)}">${esc(p.name)}</a>${years ? `<span class="toc__count">${esc(years)}</span>` : ''}<span class="toc__count">${c.entryIds.length} 条</span></li>`;
    })
    .join('');

  const volumes: string[] = [];
  if (model.options.volumes.includes('era')) {
    volumes.push(`<h2 id="toc-era">${BOOK_VOLUME_LABELS.era} · 以年代为序</h2>\n<ol>${eraToc || '<li>（无收录条目）</li>'}</ol>`);
  }
  if (model.options.volumes.includes('person')) {
    volumes.push(`<h2 id="toc-person">${BOOK_VOLUME_LABELS.person} · 以人物为纲</h2>\n<ol>${personToc || '<li>（暂无人物关联条目）</li>'}</ol>`);
  }
  volumes.push(`<h2>索引</h2>
<ol>
  <li><a href="index/entries.html">条目索引</a><span class="toc__count">按标题排序</span></li>
  <li><a href="index/people.html">人物索引</a><span class="toc__count">按姓名排序</span></li>
  <li><a href="index/places.html">地点索引</a><span class="toc__count">按地名归组</span></li>
</ol>`);

  const body = `<main class="page">
<header class="cover">
  <div class="cover__mark">家 史 册</div>
  <h1>${esc(model.title)}</h1>
  <div class="cover__family">${esc(model.familyName)}</div>
  <div class="cover__meta">
    共 ${model.entries.length} 条 · ${model.people.length} 位人物 · ${plan.eraChapters.length + plan.personChapters.length} 章<br>
    ${esc(formatDateTime(model.generatedAt))} 生成
  </div>
</header>
<div class="toc">
${volumes.join('\n')}
</div>
</main>`;
  return shell('index.html', model, 'home', '封面与总目录', body);
}

// ---------- 编年卷章节 ----------

function renderEraChapter(model: BookModel, chapter: BookPlan['eraChapters'][number]): string {
  const path = eraFileName(chapter.key);
  const entriesById = new Map(model.entries.map((e) => [e.id, e]));
  const cards = chapter.entryIds
    .map((id) => entriesById.get(id))
    .filter((e): e is BookEntryModel => Boolean(e))
    .map((e) => entryCard(path, model, e))
    .join('\n');

  const idx = model.plan.eraChapters.findIndex((c) => c.key === chapter.key);
  const prev = model.plan.eraChapters[idx - 1];
  const next = model.plan.eraChapters[idx + 1];
  const pager = `<div class="pager">
  <span>${prev ? `<a href="${href(path, eraFileName(prev.key))}">← ${esc(prev.title)}</a>` : ''}</span>
  <span>${next ? `<a href="${href(path, eraFileName(next.key))}">${esc(next.title)} →</a>` : ''}</span>
</div>`;

  const body = `<main class="page chapter">
<header class="chapter-head">
  <div class="chapter-head__kicker">${BOOK_VOLUME_LABELS.era}</div>
  <h1>${esc(chapter.title)}</h1>
  <div class="chapter-head__sub">共 ${chapter.entryIds.length} 条</div>
</header>
${cards}
${pager}
</main>`;
  return shell(path, model, 'era', chapter.title, body);
}

// ---------- 人物卷章节 ----------

function renderPersonChapter(model: BookModel, chapter: BookPlan['personChapters'][number]): string {
  const path = personFileName(chapter.personId);
  const person = model.people.find((p) => p.id === chapter.personId);
  if (!person) return '';
  const entriesById = new Map(model.entries.map((e) => [e.id, e]));

  // 章内按「人物角色」分组呈现：来源 / 赠送 / 继承 / 原主 / 提及
  const groups = new Map<PersonRole, BookEntryModel[]>();
  for (const id of chapter.entryIds) {
    const entry = entriesById.get(id);
    if (!entry) continue;
    const link = entry.people.find((p) => p.personId === chapter.personId);
    const role = link?.role ?? 'mentioned';
    const list = groups.get(role) ?? [];
    list.push(entry);
    groups.set(role, list);
  }
  const sections = [...groups.entries()]
    .map(([role, list]) => `<h2 class="role-group">${PERSON_ROLE_LABELS[role]}</h2>\n${list.map((e) => entryCard(path, model, e)).join('\n')}`)
    .join('\n');

  const years = personYearsOf(person);
  const body = `<main class="page person-page">
<header class="person-head">
  <div class="chapter-head__kicker">${BOOK_VOLUME_LABELS.person}</div>
  <h1>${esc(person.name)}</h1>
  <div class="person-head__years">${[person.relation, years].filter(Boolean).map(esc).join(' · ')}</div>
  ${person.bio ? `<div class="person-bio">${esc(person.bio)}</div>` : ''}
</header>
${sections}
</main>`;
  return shell(path, model, 'person', person.name, body);
}

// ---------- 条目页 ----------

function renderEntry(model: BookModel, entry: BookEntryModel): string {
  const seq = model.plan.entrySeq[entry.id]!;
  const path = entryFileName(seq, entry.id);
  const sourceUrl = entrySourceUrl(model.sourceUrl, model.familyId, entry.id);

  const peopleRows = entry.people
    .map((p) => {
      const inBook = model.plan.personChapters.some((c) => c.personId === p.personId);
      const name = inBook ? `<a href="${href(path, personFileName(p.personId))}">${esc(p.name)}</a>` : esc(p.name);
      return `${name}（${PERSON_ROLE_LABELS[p.role]}）`;
    })
    .join('、');

  const metaRows: Array<[string, string]> = [
    ['分类', esc(entry.categoryLabel)],
    ['获得时间', `${esc(entry.acquiredDisplay)}${entry.timeUncertain ? ' <span class="uncertain">时间存疑</span>' : ''}`],
  ];
  if (entry.acquiredNote) metaRows.push(['时间依据', esc(entry.acquiredNote)]);
  if (entry.placeLabel) metaRows.push(['地点', esc(entry.placeLabel)]);
  if (peopleRows) metaRows.push(['相关人物', peopleRows]);
  if (entry.storageLocation) metaRows.push(['存放位置', esc(entry.storageLocation)]);
  if (entry.condition) metaRows.push(['保存状况', esc(entry.condition)]);
  metaRows.push(['记录者', esc(entry.creatorName)]);

  const mediaHtml = entry.media
    .map((m) => {
      const caption = m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : '';
      if (m.kind === 'image') {
        return `<figure class="media-figure"><img src="${href(path, m.file)}" alt="${esc(m.caption ?? entry.title)}" loading="lazy">${caption}</figure>`;
      }
      if (m.kind === 'audio') {
        const transcript = m.transcript ? `<div class="transcript">${esc(m.transcript)}</div>` : '';
        return `<div class="media-audio"><audio controls preload="none" src="${href(path, m.file)}"></audio>${m.caption ? `<div class="entry-card__meta">${esc(m.caption)}</div>` : ''}${transcript}</div>`;
      }
      return `<a class="media-doc" href="${href(path, m.file)}" download>📄 ${esc(m.originalName)}</a>`;
    })
    .join('\n');

  const ordered = [...model.entries].sort((a, b) => (model.plan.entrySeq[a.id] ?? 0) - (model.plan.entrySeq[b.id] ?? 0));
  const idx = ordered.findIndex((e) => e.id === entry.id);
  const prev = ordered[idx - 1];
  const next = ordered[idx + 1];
  const pager = `<div class="pager">
  <span>${prev ? `<a href="${href(path, model.plan.entryFile[prev.id]!)}">← ${esc(prev.title)}</a>` : ''}</span>
  <span>${next ? `<a href="${href(path, model.plan.entryFile[next.id]!)}">${esc(next.title)} →</a>` : ''}</span>
</div>`;

  const body = `<main class="page entry-page">
<header class="entry__head">
  <div class="entry__seq">第 ${String(seq).padStart(3, '0')} 条</div>
  <h1>${esc(entry.title)}</h1>
</header>
<table class="meta-table">
${metaRows.map(([k, v]) => `  <tr><th>${k}</th><td>${v}</td></tr>`).join('\n')}
</table>
${entry.storyHtml ? `<div class="story">${entry.storyHtml}</div>` : ''}
${mediaHtml}
${entry.tags.length ? `<div class="tag-row">${entry.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
<div class="entry__source">
  系统原始条目（联网可查看最新版本与全部媒体）：<a href="${esc(sourceUrl)}">${esc(sourceUrl)}</a><br>
  条目编号：${esc(entry.id)}
</div>
${pager}
</main>`;
  return shell(path, model, 'home', entry.title, body);
}

// ---------- 索引页 ----------

function renderEntriesIndex(model: BookModel): string {
  const path = 'index/entries.html';
  const entriesById = new Map(model.entries.map((e) => [e.id, e]));
  const rows = model.plan.titleIndex
    .map((id) => entriesById.get(id))
    .filter((e): e is BookEntryModel => Boolean(e))
    .map((e) => {
      const seq = model.plan.entrySeq[e.id]!;
      return `<li><a href="${href(path, model.plan.entryFile[e.id]!)}">${esc(e.title)}</a><span class="meta">${String(seq).padStart(3, '0')} · ${esc(e.acquiredDisplay)}</span></li>`;
    })
    .join('\n');
  const body = `<main class="page">
<header class="chapter-head"><div class="chapter-head__kicker">索引</div><h1>条目索引</h1><div class="chapter-head__sub">按标题排序，共 ${model.plan.titleIndex.length} 条</div></header>
<ul class="index-list">${rows}</ul>
</main>`;
  return shell(path, model, 'index', '条目索引', body);
}

function renderPeopleIndex(model: BookModel): string {
  const path = 'index/people.html';
  const peopleById = new Map(model.people.map((p) => [p.id, p]));
  const rows = model.plan.peopleIndex
    .map((id) => peopleById.get(id))
    .filter((p): p is BookPersonModel => Boolean(p))
    .map((p) => {
      const chapter = model.plan.personChapters.find((c) => c.personId === p.id);
      const years = personYearsOf(p);
      const meta = [p.relation, years, chapter ? `${chapter.entryIds.length} 条` : '无关联条目'].filter(Boolean).join(' · ');
      const name = chapter ? `<a href="${href(path, personFileName(p.id))}">${esc(p.name)}</a>` : esc(p.name);
      return `<li>${name}<span class="meta">${esc(meta)}</span></li>`;
    })
    .join('\n');
  const body = `<main class="page">
<header class="chapter-head"><div class="chapter-head__kicker">索引</div><h1>人物索引</h1><div class="chapter-head__sub">按姓名排序，共 ${model.plan.peopleIndex.length} 位</div></header>
<ul class="index-list">${rows || '<li><span class="meta">暂无人物档案</span></li>'}</ul>
</main>`;
  return shell(path, model, 'index', '人物索引', body);
}

function renderPlacesIndex(model: BookModel): string {
  const path = 'index/places.html';
  const entriesById = new Map(model.entries.map((e) => [e.id, e]));
  const sections = model.plan.placeIndex
    .map((group) => {
      const rows = group.entryIds
        .map((id) => entriesById.get(id))
        .filter((e): e is BookEntryModel => Boolean(e))
        .map((e) => `<li><a href="${href(path, model.plan.entryFile[e.id]!)}">${esc(e.title)}</a><span class="meta">${esc(e.acquiredDisplay)}</span></li>`)
        .join('\n');
      return `<h2 class="role-group">${esc(group.label)}</h2>\n<ul class="index-list">${rows}</ul>`;
    })
    .join('\n');
  const body = `<main class="page">
<header class="chapter-head"><div class="chapter-head__kicker">索引</div><h1>地点索引</h1><div class="chapter-head__sub">按地名归组，共 ${model.plan.placeIndex.length} 处</div></header>
${sections || '<p class="chapter-head__sub">所有条目都还没有记录地点。</p>'}
</main>`;
  return shell(path, model, 'index', '地点索引', body);
}

// ---------- 总装 ----------

/** 渲染整本书：返回全部页面（含样式表），键为书内相对路径。 */
export function renderBook(model: BookModel): BookPage[] {
  const pages: BookPage[] = [{ path: CSS_PATH, content: BOOK_CSS }];
  pages.push({ path: 'index.html', content: renderCover(model) });
  for (const chapter of model.plan.eraChapters) {
    pages.push({ path: eraFileName(chapter.key), content: renderEraChapter(model, chapter) });
  }
  for (const chapter of model.plan.personChapters) {
    const content = renderPersonChapter(model, chapter);
    if (content) pages.push({ path: personFileName(chapter.personId), content });
  }
  for (const entry of model.entries) {
    const seq = model.plan.entrySeq[entry.id]!;
    pages.push({ path: entryFileName(seq, entry.id), content: renderEntry(model, entry) });
  }
  pages.push({ path: 'index/entries.html', content: renderEntriesIndex(model) });
  pages.push({ path: 'index/people.html', content: renderPeopleIndex(model) });
  pages.push({ path: 'index/places.html', content: renderPlacesIndex(model) });
  return pages;
}
