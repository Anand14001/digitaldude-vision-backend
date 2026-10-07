import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';
import { badRequest } from './errors';

export interface StoredFile {
  provider: 'LOCAL' | 'CLOUDINARY' | 'S3';
  storageKey: string;
  url: string;
  checksum: string;
}

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Allowlist rather than denylist: anything not listed is rejected, so an
 * uploaded .html or .svg can never be served back as active content.
 */
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'application/pdf',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
]);

let cloudinaryReady = false;
function initCloudinary() {
  if (cloudinaryReady) return;
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw badRequest('Cloudinary is selected as the storage provider but is not configured');
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  cloudinaryReady = true;
}

export function assertUploadAllowed(file: { mimetype: string; size: number }): void {
  if (file.size > MAX_BYTES) throw badRequest('File exceeds the 50 MB limit');
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw badRequest(`File type ${file.mimetype} is not allowed`);
  }
}

/** Strips directory parts and anything that is not a safe filename character. */
export function safeName(original: string): string {
  const base = path.basename(original).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(-120) || 'file';
}

export async function storeFile(opts: {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  folder: string;
}): Promise<StoredFile> {
  const checksum = crypto.createHash('sha256').update(opts.buffer).digest('hex');
  const key = `${opts.folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeName(opts.originalName)}`;

  if (env.STORAGE_PROVIDER === 'cloudinary') {
    initCloudinary();
    const uploaded = await new Promise<{ secure_url: string; public_id: string }>(
      (resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            { folder: `digital-dude/${opts.folder}`, resource_type: 'auto' },
            (error, result) =>
              error || !result
                ? reject(error ?? new Error('Cloudinary upload failed'))
                : resolve(result as { secure_url: string; public_id: string }),
          )
          .end(opts.buffer);
      },
    );
    return {
      provider: 'CLOUDINARY',
      storageKey: uploaded.public_id,
      url: uploaded.secure_url,
      checksum,
    };
  }

  const dir = path.resolve(env.LOCAL_UPLOAD_DIR, opts.folder);
  await fs.mkdir(dir, { recursive: true });
  const absolute = path.resolve(env.LOCAL_UPLOAD_DIR, key);
  // Defence in depth: never write outside the configured upload root.
  if (!absolute.startsWith(path.resolve(env.LOCAL_UPLOAD_DIR))) {
    throw badRequest('Invalid upload path');
  }
  await fs.writeFile(absolute, opts.buffer);
  return {
    provider: 'LOCAL',
    storageKey: key,
    url: `${env.API_URL}/uploads/${key}`,
    checksum,
  };
}

export async function deleteStoredFile(provider: string, storageKey: string): Promise<void> {
  if (provider === 'CLOUDINARY') {
    initCloudinary();
    await cloudinary.uploader.destroy(storageKey, { resource_type: 'auto' });
    return;
  }
  const absolute = path.resolve(env.LOCAL_UPLOAD_DIR, storageKey);
  if (!absolute.startsWith(path.resolve(env.LOCAL_UPLOAD_DIR))) return;
  await fs.rm(absolute, { force: true });
}
