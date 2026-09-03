import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(process.cwd(), 'src/components/WorkMediaCard.vue'), 'utf8');
const linkRule = source.match(/\.work-media-card__link\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';
const imageRule = source.match(/\.work-media-card__image\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? '';

describe('WorkMediaCard visual contract', () => {
  it('uses one borderless square-edged container for both media types', () => {
    expect(linkRule).not.toMatch(/\bborder\s*:/);
    expect(linkRule).not.toMatch(/\bborder-radius\s*:/);
    expect(linkRule).not.toMatch(/\bbox-shadow\s*:/);
    expect(source.match(/<a\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/item\.mediaType[^\n]*work-media-card__link/);
  });

  it('keeps complete-image rendering, lazy loading, and lightweight video posters', () => {
    expect(imageRule).toMatch(/object-fit:\s*contain/);
    expect(source).toContain('loading="lazy"');
    expect(source).toContain("item.mediaType === 'video'");
    expect(source).not.toMatch(/<video\b|<media-player\b/);
  });

  it('retains an accessibility outline without adding a persistent focus border', () => {
    expect(source).toMatch(/\.work-media-card__link:focus-visible\s*\{[^}]*outline:/s);
  });
});
