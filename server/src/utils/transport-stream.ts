import path from 'node:path';

interface VideoProbe {
  format?: { format_name?: string };
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
}

/** A .ts suffix also names TypeScript files; require an actual MPEG-TS video. */
export function assertTransportStreamVideoProbe(sourcePath: string, probe: VideoProbe): void {
  if (path.extname(sourcePath).toLowerCase() !== '.ts') return;
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  if (!probe.format?.format_name?.split(',').includes('mpegts')
    || !video || !Number.isInteger(video.width) || !Number.isInteger(video.height)
    || (video.width ?? 0) <= 0 || (video.height ?? 0) <= 0) {
    throw new Error('MPEG-TS 文件未检测到有效视频流，或实际容器格式不匹配');
  }
}
