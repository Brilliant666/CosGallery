import { requestJson } from './http';

export interface MediaTrashResult {
  ok: true;
  postId: number;
  mediaId: number;
  remainingMediaCount: number;
  postTrashed: boolean;
}
export interface TrashedMedia {
  mediaId: number;
  postId: number;
  creatorId: number | null;
  postTitle: string;
  filename: string;
  mediaType: 'image' | 'video';
  thumbnailUrl: string | null;
  trashedAt: string;
}
export const trashPostMedia = (
  postId: number,
  mediaId: number,
  confirmLastMedia = false,
) =>
  requestJson<MediaTrashResult>(`/api/posts/${postId}/media/${mediaId}/trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmLastMedia }),
  });
export const restorePostMedia = (postId: number, mediaId: number) =>
  requestJson<MediaTrashResult>(
    `/api/posts/${postId}/media/${mediaId}/restore`,
    { method: 'POST' },
  );
export const fetchTrashedMedia = () =>
  requestJson<{ items: TrashedMedia[]; total: number }>('/api/trash/media');
