import path from 'node:path';

export type ImageRetentionReason = 'pixel_limit' | 'decode_failed';

const supportedImages = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const operationalFailure = /\b(?:EACCES|EPERM|ENOENT|EIO|EBUSY|ENOMEM|ENOSPC|EMFILE|ENFILE|ENOBUFS|ESTALE|ETIMEDOUT|bad_alloc)\b|permission|access denied|not permitted|no such file|file not found|missing file|cannot open|unable to open|could not open|file is (?:locked|busy)|sharing violation|used by another process|input\/output|I\/O|memory|allocat|resource|thread|semaphore|timed? ?out|too many open files|file descriptor|disk (?:full|space)|no space left/i;

/** Only a diagnosed image-content failure can become an explicit retention choice. */
export function imageRetentionReason(error: unknown, filename: string): ImageRetentionReason | null {
  const extension = path.extname(filename).toLowerCase();
  if (!supportedImages.has(extension) || !(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) return null;
  // Node filesystem failures carry code/errno; also inspect wrapped causes so a
  // decoder-looking message cannot turn an operational failure into approval.
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (!(current instanceof Error) || visited.has(current)) return null;
    visited.add(current);
    if ('code' in current || 'errno' in current || operationalFailure.test(current.message)) return null;
    current = current.cause;
  }
  const message = error.message.trim();
  if (/^Input image exceeds pixel limit$/i.test(message)) {
    return ['.jpg', '.jpeg'].includes(extension) ? 'pixel_limit' : null;
  }
  if (/^Input (?:buffer|file) contains unsupported image format$/i.test(message)
    || /^Input (?:buffer|file) has corrupt header:/i.test(message)
    || /^(?:VipsJpeg|jpegload(?:_buffer)?|pngload(?:_buffer)?|gifload(?:_buffer)?|webpload(?:_buffer)?):[^\n]*(?:corrupt|invalid|truncat|premature|not a JPEG|bad (?:header|Huffman|PNG)|unexpected end)/im.test(message)) {
    return 'decode_failed';
  }
  return null;
}
