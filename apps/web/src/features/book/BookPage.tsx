import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Spinner, Tag, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useFamily } from '../families/useFamily';
import { formatBytes } from '../../lib/format';
import type { BookJob } from '../../api/types';

type Volume = 'era' | 'person';

const VOLUME_LABELS: Record<Volume, string> = {
  era: '编年卷 · 按年代分章',
  person: '人物卷 · 按人物分章',
};

export function BookPage() {
  const { fid } = useParams<{ fid: string }>();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);

  const [title, setTitle] = useState('');
  const [volumes, setVolumes] = useState<Volume[]>(['era', 'person']);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);

  const job = useQuery({
    queryKey: ['book', fid, jobId],
    queryFn: () => api.get<{ job: BookJob }>(`/families/${fid}/books/${jobId}`),
    enabled: Boolean(fid && jobId),
    refetchInterval: (q) => {
      const data = q.state.data as { job: BookJob } | undefined;
      return data && (data.job.status === 'done' || data.job.status === 'failed') ? false : 1500;
    },
  });

  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/families/${fid}/books`, {
        title: title.trim() || undefined,
        volumes,
        includeArchived,
      }),
    onSuccess: (data) => {
      setJobId(data.jobId);
      push('家史册开始生成，完成后可以直接下载', 'success');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '发起生成失败', 'error'),
  });

  if (!familyData) return <Spinner />;
  const current = job.data?.job;
  const bookTitle = title.trim() || `${familyData.family.name}家史册`;

  const toggleVolume = (v: Volume) => {
    setVolumes((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家史册</h1>
          <p className="page-head__sub">把全家可见的条目排版成一本书：按年代与人物分章，自动生成目录与索引，导出后离线也能翻阅。</p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>排版选项</h2>
        <Field label="书名" hint={`留空则使用「${familyData.family.name}家史册」`}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder={bookTitle} />
        </Field>
        <Field label="收录卷目" group>
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            {(Object.keys(VOLUME_LABELS) as Volume[]).map((v) => (
              <label key={v} className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={volumes.includes(v)} onChange={() => toggleVolume(v)} />
                <span>{VOLUME_LABELS[v]}</span>
              </label>
            ))}
          </div>
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--space-4)' }}>
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          <span>同时收录「已归档」的条目</span>
        </label>
        <Button variant="primary" loading={start.isPending} disabled={volumes.length === 0} onClick={() => start.mutate()}>
          生成家史册
        </Button>
        {volumes.length === 0 ? <p className="field__error">至少选择一卷</p> : null}
      </section>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>收录范围</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          只收录「已发布{includeArchived ? ' / 已归档' : ''}」且「全家人可见 / 链接可见」的条目；
          草稿、仅自己可见和指定成员可见的条目不会进书。每个条目页末尾都保留系统内原始条目的链接，联网时可回查最新版本。
        </p>
      </section>

      {current ? (
        <section className="card">
          <div className="card__head">
            <h2>生成进度</h2>
            {current.status === 'done' && current.downloadUrl ? (
              <a className="btn btn--primary btn--sm" href={current.downloadUrl}>
                下载 ZIP{current.result?.bytes ? `（${formatBytes(current.result.bytes)}）` : ''}
              </a>
            ) : null}
          </div>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <span>状态：</span>
            {current.status === 'queued' ? <Tag>排队中</Tag> : null}
            {current.status === 'running' ? <Tag>排版中 {current.progress}%</Tag> : null}
            {current.status === 'done' ? <Tag tone="success">已完成</Tag> : null}
            {current.status === 'failed' ? <Tag tone="warn">失败</Tag> : null}
          </div>
          {current.status === 'done' && current.result ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              共 {current.result.entries ?? 0} 条 · {current.result.chapters ?? 0} 章 · {current.result.media ?? 0} 个媒体文件。
              解压后用浏览器打开 index.html 即可阅读。
            </p>
          ) : null}
          {current.lastError ? <p className="field__error">{current.lastError}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
