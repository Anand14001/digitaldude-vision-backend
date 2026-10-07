import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, created, noContent, ok } from '../../lib/http';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { auditFromRequest } from '../../lib/audit';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { assertUploadAllowed, deleteStoredFile, storeFile } from '../../lib/storage';
import { clientWhere, projectWhere, taskWhere } from '../../lib/scope';
import type { AuthContext } from '../../types/express';

export const filesRouter = Router();

/** Files are buffered in memory, then checked and handed to the provider. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

const attachQuery = z.object({
  clientId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  taskId: z.string().cuid().optional(),
  /** Free-standing uploads (avatars, documents) are attached by the caller later. */
  folder: z.enum(['avatars', 'logos', 'documents', 'deliverables', 'tasks', 'misc']).default('misc'),
});

/** The caller must already have write access to whatever they attach a file to. */
async function assertAttachable(ctx: AuthContext, target: z.infer<typeof attachQuery>) {
  if (target.taskId) {
    const found = await prisma.task.count({
      where: { AND: [taskWhere(ctx), { id: target.taskId }] },
    });
    if (!found) throw notFound('Task');
  }
  if (target.projectId) {
    const found = await prisma.project.count({
      where: { AND: [projectWhere(ctx), { id: target.projectId }] },
    });
    if (!found) throw notFound('Project');
  }
  if (target.clientId) {
    const found = await prisma.client.count({
      where: { AND: [clientWhere(ctx), { id: target.clientId }] },
    });
    if (!found) throw notFound('Client');
  }
}

filesRouter.use(requireAuth);

filesRouter.post(
  '/',
  uploadLimiter,
  upload.array('files', 10),
  validate({ query: attachQuery }),
  asyncHandler(async (req, res) => {
    const target = req.query as unknown as z.infer<typeof attachQuery>;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!uploaded.length) throw badRequest('No files were uploaded');

    await assertAttachable(req.ctx, target);

    const records = [];
    for (const file of uploaded) {
      assertUploadAllowed({ mimetype: file.mimetype, size: file.size });
      const stored = await storeFile({
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        folder: target.folder,
      });

      records.push(
        await prisma.fileObject.create({
          data: {
            provider: stored.provider,
            storageKey: stored.storageKey,
            url: stored.url,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            checksum: stored.checksum,
            uploadedById: req.ctx.user.id,
            clientId: target.clientId ?? null,
            projectId: target.projectId ?? null,
            taskId: target.taskId ?? null,
          },
        }),
      );
    }

    await auditFromRequest(req, {
      action: 'FILE_UPLOAD',
      entityType: 'File',
      entityId: records[0]?.id ?? null,
      summary: `Uploaded ${records.length} file(s)`,
    });

    return created(res, records);
  }),
);

filesRouter.get(
  '/',
  validate({
    query: z.object({
      clientId: z.string().cuid().optional(),
      projectId: z.string().cuid().optional(),
      taskId: z.string().cuid().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as {
      clientId?: string;
      projectId?: string;
      taskId?: string;
    };
    if (!q.clientId && !q.projectId && !q.taskId) {
      throw badRequest('Specify a client, project or task');
    }
    await assertAttachable(req.ctx, { ...q, folder: 'misc' });

    const files = await prisma.fileObject.findMany({
      where: {
        deletedAt: null,
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.taskId ? { taskId: q.taskId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });

    return ok(res, files);
  }),
);

/** Sets the caller's own avatar from an already uploaded file. */
filesRouter.post(
  '/:id/set-avatar',
  asyncHandler(async (req, res) => {
    const file = await prisma.fileObject.findFirst({
      where: { id: req.params.id, deletedAt: null, uploadedById: req.ctx.user.id },
      select: { id: true, mimeType: true },
    });
    if (!file) throw notFound('File');
    if (!file.mimeType.startsWith('image/')) throw badRequest('An avatar must be an image');

    await prisma.user.update({
      where: { id: req.ctx.user.id },
      data: { avatarFileId: file.id },
    });
    return ok(res, { avatarFileId: file.id });
  }),
);

filesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const file = await prisma.fileObject.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: {
        id: true,
        originalName: true,
        provider: true,
        storageKey: true,
        uploadedById: true,
        deliverableVersionId: true,
      },
    });
    if (!file) throw notFound('File');

    // Uploader or an admin only; and never a file already published in a
    // deliverable version, which must stay auditable.
    if (file.uploadedById !== req.ctx.user.id && !req.ctx.user.isAdmin) {
      throw forbidden('You can only delete files you uploaded');
    }
    if (file.deliverableVersionId) {
      throw badRequest('This file belongs to a deliverable version and cannot be deleted');
    }

    await prisma.fileObject.update({
      where: { id: file.id },
      data: { deletedAt: new Date() },
    });
    // Best effort: the row is already soft-deleted, so storage can lag behind.
    await deleteStoredFile(file.provider, file.storageKey).catch(() => undefined);

    await auditFromRequest(req, {
      action: 'FILE_DELETE',
      entityType: 'File',
      entityId: file.id,
      entityLabel: file.originalName,
      summary: `Deleted file "${file.originalName}"`,
    });

    return noContent(res);
  }),
);
