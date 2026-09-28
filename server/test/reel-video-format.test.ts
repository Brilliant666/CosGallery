import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { binary } = vi.hoisted(() => ({ binary: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: binary }) }));

describe('scoped reel format inspection', () => {
  let root: string;
  let formats: typeof import('../src/services/reel-video-format.js');
  const h264 = { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'aac' }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } } };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-formats-'));
    vi.stubEnv('NODE_ENV', 'test');
    formats = await import('../src/services/reel-video-format.js');
  });
  afterAll(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

  it.each(['mp4', 'm4v'])('allows verified H264/AAC %s originals', extension => {
    expect(formats.classifyReelVideo(`clip.${extension}`, h264)).toEqual({ mode: 'original', mimeType: 'video/mp4' });
  });
  it.each(['mov', 'mkv'])('offers lossless MP4 for compatible %s, not a lossy preview', extension => {
    expect(formats.classifyReelVideo(`clip.${extension}`, { ...h264, format: { format_name: extension === 'mkv' ? 'matroska,webm' : 'mov,mp4', tags: { major_brand: 'qt' } } })).toEqual({ mode: 'remux', mimeType: 'video/mp4' });
  });
  it('does not infer an MP4 container merely from its extension or ffprobe umbrella name', () => {
    expect(formats.classifyReelVideo('renamed.mp4', { ...h264, format: { format_name: 'mov,mp4', tags: { major_brand: 'qt' } } }).mode).toBe('remux');
    expect(formats.classifyReelVideo('renamed.mp4', { ...h264, format: { format_name: 'avi' } }).mode).toBe('preview');
  });
  it.each(['vp8', 'vp9'])('allows genuine WebM %s with compatible audio', codec => {
    const probe = { streams: [{ codec_type: 'video', codec_name: codec, pix_fmt: 'yuv420p' }, { codec_type: 'audio', codec_name: 'opus' }], format: { format_name: 'matroska,webm' } };
    expect(formats.classifyReelVideo('clip.webm', probe, true)).toEqual({ mode: 'original', mimeType: `video/webm; codecs="${codec}, opus"` });
    expect(formats.classifyReelVideo('renamed.webm', probe, false).mode).toBe('preview');
  });
  it.each(['hevc', 'prores', 'av1'])('does not authorize stream-copy fallback for unverified %s', codec => {
    expect(formats.classifyReelVideo('clip.mov', { ...h264, streams: [{ ...h264.streams[0]!, codec_name: codec }] }).mode).toBe('preview');
  });
  it('rejects unsupported pixel formats, audio and multiple tracks', () => {
    expect(formats.classifyReelVideo('clip.mov', { ...h264, streams: [{ ...h264.streams[0]!, pix_fmt: 'yuv420p10le' }] }).mode).toBe('preview');
    expect(formats.classifyReelVideo('clip.mov', { ...h264, streams: [h264.streams[0]!, { codec_type: 'audio', codec_name: 'pcm_s16le' }] }).mode).toBe('preview');
    expect(formats.classifyReelVideo('clip.mov', { ...h264, streams: [...h264.streams, h264.streams[1]!] }).mode).toBe('preview');
    expect(formats.classifyReelVideo('clip.mov', { ...h264, streams: [h264.streams[0]!] }).mode).toBe('remux');
  });
  it('singleflights and caches the exact source version; changed versions are probed again', async () => {
    const source = path.join(root, 'cache.mov');
    await fs.writeFile(source, 'synthetic-one');
    let stat = await fs.stat(source);
    let version = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    binary.mockResolvedValue({ stdout: JSON.stringify(h264) });
    const count = binary.mock.calls.length;
    await Promise.all([formats.inspectReelVideo(source, version), formats.inspectReelVideo(source, version)]);
    await formats.inspectReelVideo(source, version);
    expect(binary.mock.calls.length - count).toBe(1);
    await fs.appendFile(source, '-changed');
    stat = await fs.stat(source);
    version = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    await formats.inspectReelVideo(source, version);
    expect(binary.mock.calls.length - count).toBe(2);
  });
  it('rejects a source changed during probing and does not cache a failed inspection', async () => {
    const source = path.join(root, 'race.mov');
    await fs.writeFile(source, 'before');
    const stat = await fs.stat(source);
    const version = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    binary.mockImplementationOnce(async () => { await fs.appendFile(source, '-changed'); return { stdout: JSON.stringify(h264) }; });
    await expect(formats.inspectReelVideo(source, version)).rejects.toMatchObject({ code: 'SOURCE_INDEX_OUTDATED' });
    const second = path.join(root, 'failed.mov');
    await fs.writeFile(second, 'synthetic');
    const current = await fs.stat(second);
    const key = `${current.size}:${Math.round(current.mtimeMs)}`;
    binary.mockRejectedValueOnce(new Error('failed')).mockResolvedValue({ stdout: JSON.stringify(h264) });
    await expect(formats.inspectReelVideo(second, key)).rejects.toThrow('failed');
    expect((await formats.inspectReelVideo(second, key)).mode).toBe('remux');
  });
  it('requests stream copy and faststart without scaling or encoders', async () => {
    binary.mockResolvedValue({ stdout: '' });
    await formats.writeReelRemux('input.mov', 'output.mp4');
    const args = binary.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual(['-y', '-v', 'error', '-i', 'input.mov', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', 'output.mp4']);
  });
});
