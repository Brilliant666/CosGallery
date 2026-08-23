import { normalizePath } from './path-utils.js';

function slugifyValue(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[/\\]+/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'folder';
}

export function slugifyFolderName(name: string): string {
  return slugifyValue(name);
}

export function slugifyFolderPath(folderPath: string): string {
  return slugifyValue(normalizePath(folderPath));
}

export function resolveUniqueSlug(
  value: string,
  existing: Set<string>,
  slugify: (value: string) => string = slugifyFolderName
): string {
  const base = slugify(value);
  if (!existing.has(base)) {
    existing.add(base);
    return base;
  }

  let index = 2;
  while (existing.has(`${base}-${index}`)) {
    index += 1;
  }

  const slug = `${base}-${index}`;
  existing.add(slug);
  return slug;
}
