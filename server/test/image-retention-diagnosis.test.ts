import { describe, expect, it } from 'vitest';
import { imageRetentionReason } from '../src/utils/image-retention-diagnosis.js';

describe('image retention diagnosis', () => {
  it.each(['photo.jpg', 'photo.JPEG', 'photo.png', 'photo.gif', 'photo.webp', 'photo.bmp', 'photo.avif'])('recognizes decoder format failures for %s', filename => {
    expect(imageRetentionReason(new Error('Input buffer contains unsupported image format'), filename)).toBe('decode_failed');
    expect(imageRetentionReason(new Error('Input buffer has corrupt header: pngload_buffer: invalid chunk'), filename)).toBe('decode_failed');
  });
  it('keeps the pixel safety exception restricted to JPEG', () => {
    const error = new Error('Input image exceeds pixel limit');
    expect(imageRetentionReason(error, 'photo.JPG')).toBe('pixel_limit');
    expect(imageRetentionReason(error, 'photo.png')).toBeNull();
  });
  it.each(['document.pdf', 'archive.zip', 'original.heic', 'photo.jpg.exe'])('does not grant a decoder exception to %s', filename => {
    expect(imageRetentionReason(new Error('Input buffer contains unsupported image format'), filename)).toBeNull();
  });
  it.each(['EACCES', 'EPERM', 'EBUSY', 'ENOENT', 'ENOMEM', 'EIO', 'ENOSPC', 'UNKNOWN'])('rejects operational code %s even in a decoder-looking error', code => {
    expect(imageRetentionReason(Object.assign(new Error('Input buffer has corrupt header: invalid input'), { code }), 'photo.jpg')).toBeNull();
  });
  it.each(['permission denied', 'file is locked', 'out of memory', 'unable to allocate buffer', 'resource exhausted',
    'unable to open file', 'I/O error', 'no such file', 'too many open files', 'std::bad_alloc', 'failed to create thread'])('rejects wrapped operational failure: %s', message => {
    expect(imageRetentionReason(new Error(`Input buffer has corrupt header: ${message}`), 'photo.png')).toBeNull();
    expect(imageRetentionReason(new Error('Input buffer contains unsupported image format', { cause: new Error(message) }), 'photo.png')).toBeNull();
  });
  it.each([new Error('decoder unexpectedly stopped'), new Error('missing image metadata'), new Error('Input file is missing'),
    new TypeError('Input buffer contains unsupported image format'), new RangeError('Input buffer contains unsupported image format'),
    'Input buffer contains unsupported image format', null])('refuses unknown or non-content errors', error => {
    expect(imageRetentionReason(error, 'photo.jpg')).toBeNull();
  });
});
