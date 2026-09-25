export interface BuildInfo {
  product: string;
  version: string;
  commit: string | null;
  tree: string | null;
  dirty: boolean | null;
  builtAt: string;
  node: string;
}
export const root: string;
export function createBuildInfo(cwd?: string): BuildInfo;
