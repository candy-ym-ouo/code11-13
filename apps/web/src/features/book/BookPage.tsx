import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, TextInput } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useFamily } from '../families/useFamily';
import { formatBytes } from '../../lib/format';

interface BookJob {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  lastError: string | null;
  downloadUrl: string | null;
  result: { items?: number; chapters?: number; media?: number; bytes?: number } | null;
}

export function BookPage() {
  const { fid } = useParams<{ fid: string }>();
  const { push } = useToast();
  const { data: familyData } = useFamily(fid);

  const [title, setTitle] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [includeRestricted, setIncludeRestricted] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const bookJob = useQuery({
    queryKey: ['book', fid, jobId],
    queryFn: () => api.get<{ job: BookJob }>(`/families/${fid}/book/${jobId}`),
    enabled: Boolean(fid && jobId),
    refetchInterval: (q) => {
      const data = q.state.data as { job: BookJob } | undefined;
      return data && (data.job.status === 'done' || data.job.status === 'failed') ? false : 1500;
    },
  });

  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/families/${fid}/book`, {
        title: title.trim() || undefined,
        includeDrafts,
        includeRestricted,
      }),
    onSuccess: (data) => {
      setJobId(data.jobId);
      push('家史册已开始排版，完成后可以直接下载', 'success');
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '发起生成失败', 'error'),
  });

  const job = bookJob.data?.job;
  const defaultTitle = `${familyData?.family.name ?? '家'} · 家史册`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>家史册</h1>
          <p className="page-head__sub">
            把全家的条目排版成一本书：按年代与人物分卷，自动生成目录与索引，导出后可离线翻阅。
          </p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-4)' }}>编排选项</h2>
        <Field label="书名" hint={`留空则使用「${defaultTitle}」`}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={defaultTitle} />
        </Field>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--space-3)' }}>
          <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
          <span>收录草稿（默认只收录已发布与已归档的条目）</span>
        </label>
        <label className="row" style={{ gap: 8, marginBottom: 'var(--space-4)' }}>
          <input type="checkbox" checked={includeRestricted} onChange={(e) => setIncludeRestricted(e.target.checked)} />
          <span>收录限阅条目（仅自己可见、指定成员可见；默认只收全家可见的）</span>
        </label>
        <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
          开始排版
        </Button>
      </section>

      {job ? (
        <section className="card">
          <div className="card__head">
            <h2>生成进度</h2>
            {job.status === 'done' && job.downloadUrl ? (
              <a className="btn btn--primary btn--sm" href={job.downloadUrl}>
                下载家史册{job.result?.bytes ? `（${formatBytes(job.result.bytes)}）` : ''}
              </a>
            ) : null}
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            状态：
            {job.status === 'queued'
              ? '排队中'
              : job.status === 'running'
                ? `排版中 ${job.progress}%`
                : job.status === 'done'
                  ? `已完成 · ${job.result?.items ?? 0} 条 · ${job.result?.chapters ?? 0} 章 · ${job.result?.media ?? 0} 个媒体文件`
                  : '失败'}
          </p>
          {job.lastError ? <p className="field__error">{job.lastError}</p> : null}
        </section>
      ) : null}

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-3)' }}>成品长什么样</h2>
        <p className="muted">
          下载得到一个 ZIP，解压后双击 <code>index.html</code> 即可翻阅，不依赖本系统：
        </p>
        <ul className="muted" style={{ lineHeight: 2, marginTop: 0 }}>
          <li>
            <strong>卷一 · 年代志</strong>：按年代分章，时间说不清的条目归入附录并标注「时间存疑」
          </li>
          <li>
            <strong>卷二 · 人物志</strong>：每位人物一章，小传在前，相关条目在后
          </li>
          <li>
            <strong>卷三 · 索引</strong>：人物、地点、标签、分类四种索引，自动生成
          </li>
          <li>
            <strong>条目页</strong>：完整故事、图片、录音（可播放）与文件；页底保留「原始条目」链接，系统在线时可跳回档案
          </li>
        </ul>
      </section>
    </div>
  );
}
