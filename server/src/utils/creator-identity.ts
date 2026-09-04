/** Candidate discovery only: collisions must remain explicit, never merged. */
export function normalizeCreatorIdentity(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_\-@·・.]+/gu, '');
}
