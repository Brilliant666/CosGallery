import { describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({
  parseMock: vi.fn()
}));

vi.mock('exifr', () => ({
  default: {
    parse: parseMock
  }
}));

describe('EXIF parsing tolerance', () => {
  it('treats parser failures as missing EXIF instead of scan errors', async () => {
    parseMock.mockRejectedValueOnce(new Error('Unknown file format'));

    const { extractTakenAt } = await import('../src/utils/exif-utils.js');

    await expect(extractTakenAt('/tmp/example.webp')).resolves.toBeNull();
  });
});
