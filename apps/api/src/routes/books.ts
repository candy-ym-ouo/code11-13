import { Router } from 'express';
import fs from 'node:fs';
import { bookBuildSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as bookService from '../services/bookService';
import * as audit from '../services/auditService';
import { notFound } from '../http/errors';

export const booksRouter = Router({ mergeParams: true });

booksRouter.post(
  '/',
  // 家史册与全量导出同级：会打包全家可见的全部条目，沿用 family:export 权限
  requireFamily('family:export'),
  writeLimiter,
  validateBody(bookBuildSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const job = await bookService.createBookJob(user.id, ctx, req.body, clientMeta(req));
    res.status(202).json(job);
  }),
);

booksRouter.get(
  '/:jobId',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ job: await bookService.getBookJob(ctx.familyId, req.params.jobId!) });
  }),
);

booksRouter.get(
  '/:jobId/download',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const job = await bookService.getBookJob(ctx.familyId, req.params.jobId!);
    if (job.status !== 'done') throw notFound('家史册尚未生成完成');
    const file = bookService.bookZipPath(ctx.familyId, job.jobId);
    if (!fs.existsSync(file)) throw notFound('家史册文件已被清理，请重新生成');
    await audit.record({
      familyId: ctx.familyId,
      actorId: user.id,
      action: 'book.download',
      targetType: 'job',
      targetId: job.jobId,
      ...clientMeta(req),
    });
    res.download(file, `jiashice-${job.jobId}.zip`);
  }),
);
