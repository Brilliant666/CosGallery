import { readFileSync } from 'node:fs';

export interface BuildInfo {
  product: 'CosGallery';
  version: string;
  commit: string | null;
  tree: string | null;
  dirty: boolean | null;
  builtAt: string | null;
  node: string | null;
}

const unbuilt: BuildInfo = { product: 'CosGallery', version: 'unbuilt', commit: null, tree: null, dirty: null, builtAt: null, node: null };
function readBuildInfo(): Readonly<BuildInfo> {
  try {
    const data = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')) as BuildInfo;
    if (data.product !== 'CosGallery' || typeof data.version !== 'string'
      || (data.commit !== null && !/^[a-f0-9]{40}$/.test(data.commit))
      || (data.tree !== null && !/^[a-f0-9]{40}$/.test(data.tree))) return Object.freeze(unbuilt);
    return Object.freeze({ product: data.product, version: data.version, commit: data.commit, tree: data.tree,
      dirty: typeof data.dirty === 'boolean' ? data.dirty : null,
      builtAt: typeof data.builtAt === 'string' ? data.builtAt : null, node: typeof data.node === 'string' ? data.node : null });
  } catch { return Object.freeze(unbuilt); }
}
export const buildInfo = readBuildInfo();
