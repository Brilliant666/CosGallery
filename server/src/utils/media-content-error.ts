import { imageRetentionReason, type ImageRetentionReason } from './image-retention-diagnosis.js';

/** Created only at the media metadata boundary after the source identity is rechecked. */
export class MediaContentError extends Error {
  constructor(readonly relativePath: string, readonly reason: ImageRetentionReason, cause: Error) {
    super(cause.message, { cause });
    this.name = 'MediaContentError';
  }
}

export function diagnosedMediaContentError(error: unknown, filename: string, relativePath: string): MediaContentError | null {
  const reason = imageRetentionReason(error, filename);
  return reason && error instanceof Error ? new MediaContentError(relativePath, reason, error) : null;
}
