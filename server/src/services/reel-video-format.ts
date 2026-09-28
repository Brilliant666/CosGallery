import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import { appConfig } from '../config/env.js';
import { derivativeSourceVersion, SourceIndexOutdatedError } from '../utils/derivative-version.js';

const execFileAsync = promisify(execFile);
const probeLimit = pLimit(2);
const probes = new Map<string, Promise<ReelVideoFormat>>();
const MAX_PROBE_CACHE_ENTRIES = 256;
export type ReelVideoFormat = { mode: 'original' | 'remux' | 'preview'; mimeType: string | null };
export interface ReelVideoProbe {
  streams?: Array<{ codec_type?: string; codec_name?: string; pix_fmt?: string }>;
  format?: { format_name?: string; tags?: { major_brand?: string } };
}

// Conservative fallback classification, not a browser-original allowlist.
// The playback resolver offers original bytes independently of this result.
export function classifyReelVideo(source: string, probe: ReelVideoProbe, webmContainer = false): ReelVideoFormat {
  const videos = probe.streams?.filter(stream => stream.codec_type === 'video') ?? [];
  const audio = probe.streams?.filter(stream => stream.codec_type === 'audio') ?? [];
  const fallback: ReelVideoFormat = { mode: 'preview', mimeType: null };
  if (videos.length !== 1 || audio.length > 1) return fallback;
  const video = videos[0]!;
  if (video.pix_fmt !== 'yuv420p') return fallback;
  const extension = path.extname(source).toLowerCase();
  const container = probe.format?.format_name ?? '';
  if (extension === '.webm' && webmContainer && /webm/.test(container) &&
      ['vp8', 'vp9'].includes(video.codec_name ?? '') && (!audio.length || ['opus', 'vorbis'].includes(audio[0]!.codec_name ?? ''))) {
    return { mode: 'original', mimeType: `video/webm; codecs="${[video.codec_name, audio[0]?.codec_name].filter(Boolean).join(', ')}"` };
  }
  if (video.codec_name !== 'h264' || (audio.length && audio[0]!.codec_name !== 'aac')) return fallback;
  const brand = probe.format?.tags?.major_brand?.trim() ?? '';
  if (['.mp4', '.m4v'].includes(extension) && container.split(',').includes('mp4') && /^(?:iso[0-9a-z]|mp4[12]|avc1|M4V|dash)/.test(brand)) {
    return { mode: 'original', mimeType: 'video/mp4' };
  }
  if (['.mov', '.mkv', '.m4v', '.mp4'].includes(extension) && /(?:mov|mp4|matroska)/.test(container)) {
    return { mode: 'remux', mimeType: 'video/mp4' };
  }
  return fallback;
}

async function isWebmContainer(source: string): Promise<boolean> {
  // ffprobe reports "matroska,webm" for both containers. Verify EBML DocType
  // rather than treating a renamed Matroska file as a browser-safe WebM file.
  const file = await fs.open(source, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && data.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  } finally { await file.close(); }
}

export async function inspectReelVideo(source: string, sourceVersion: string): Promise<ReelVideoFormat> {
  const key = `${source}\0${sourceVersion}`;
  const pending = probes.get(key);
  if (pending) return pending;
  const work = probeLimit(async () => {
    const before = await fs.stat(source);
    if (derivativeSourceVersion(before.size, before.mtimeMs) !== sourceVersion) throw new SourceIndexOutdatedError();
    const { stdout } = await execFileAsync(appConfig.ffprobePath, [
      '-v', 'error', '-show_entries', 'format=format_name:format_tags=major_brand:stream=codec_type,codec_name,pix_fmt', '-of', 'json', source
    ], { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const webm = path.extname(source).toLowerCase() === '.webm' && await isWebmContainer(source);
    const after = await fs.stat(source);
    if (derivativeSourceVersion(after.size, after.mtimeMs) !== sourceVersion) throw new SourceIndexOutdatedError();
    return classifyReelVideo(source, JSON.parse(stdout) as ReelVideoProbe, webm);
  });
  if (probes.size >= MAX_PROBE_CACHE_ENTRIES) probes.delete(probes.keys().next().value!);
  probes.set(key, work);
  void work.catch(() => { if (probes.get(key) === work) probes.delete(key); });
  return work;
}

export async function writeReelRemux(source: string, output: string): Promise<void> {
  await execFileAsync(appConfig.ffmpegPath, [
    '-y', '-v', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', output
  ], { maxBuffer: 2 * 1024 * 1024, windowsHide: true });
}
