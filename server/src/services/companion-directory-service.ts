import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CompanionReadError, CompanionReadService, COUNT_POLICY_VERSION, type CompanionIdentity } from './companion-read-service.js';

export interface CompanionDirectoryInput { limit?: number; cursor?: string; identityVersion?: string }
interface Alias { creatorId: number; alias: string }
type Kind = 'roster' | 'aliases';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new CompanionReadError(400, 'INVALID_COMPANION_REQUEST', '名单分页参数无效，请从第一页重新同步。');

/** A short, read-only snapshot per page. No HTTP-spanning transaction or lazy rebuild. */
export class CompanionDirectoryService {
  constructor(private readonly db: DatabaseSync, private readonly reader = new CompanionReadService(db)) {}

  private snapshot<T>(action: (creators: CompanionIdentity[], aliases: Alias[], identityVersion: string) => T): T {
    this.db.exec('SAVEPOINT companion_directory');
    try {
      const creators = this.db.prepare(`SELECT id AS creatorId,canonical_name AS canonicalName
        FROM archive_catalog_creators WHERE is_active=1 ORDER BY id`).all() as unknown as CompanionIdentity[];
      // Multiple source registrations of exactly the same alias are one public identity
      // fact. Case/Unicode differences and the same alias on another creator are retained.
      const aliases = this.db.prepare(`SELECT DISTINCT a.creator_id AS creatorId,a.alias COLLATE BINARY AS alias
        FROM archive_catalog_creator_aliases a JOIN archive_catalog_creators c ON c.id=a.creator_id
        WHERE c.is_active=1 ORDER BY a.creator_id,alias COLLATE BINARY`).all() as unknown as Alias[];
      return action(creators, aliases, fingerprint(['companion-directory-identity-v1', creators, aliases]));
    } finally {
      this.db.exec('RELEASE companion_directory');
    }
  }

  private parameters(input: CompanionDirectoryInput, kind: Kind) {
    const max = kind === 'roster' ? 50 : 200;
    const limit = input.limit ?? max;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw invalid();
    if (input.identityVersion !== undefined && (typeof input.identityVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(input.identityVersion))) throw invalid();
    if ((kind === 'aliases' || input.cursor !== undefined) && !input.identityVersion) throw invalid();
    let offset = 0;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(input.cursor)) throw invalid();
      try {
        const bytes = Buffer.from(input.cursor, 'base64url');
        if (bytes.toString('base64url') !== input.cursor) throw invalid();
        const cursor: unknown = JSON.parse(bytes.toString('utf8'));
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw invalid();
        const value = cursor as Record<string, unknown>;
        if (Object.keys(value).sort().join(',') !== 'identityVersion,kind,offset' || value.kind !== kind
          || value.identityVersion !== input.identityVersion || !Number.isSafeInteger(value.offset)
          || typeof value.offset !== 'number' || value.offset <= 0) throw invalid();
        offset = value.offset;
      } catch { throw invalid(); }
    }
    return { limit, offset };
  }

  private page<T>(items: T[], input: CompanionDirectoryInput, kind: Kind, identityVersion: string,
    parameters: { limit: number; offset: number }) {
    if (input.identityVersion !== undefined && input.identityVersion !== identityVersion)
      throw new CompanionReadError(409, 'COMPANION_IDENTITY_CHANGED', '博主或别名已变化，请保留上次完整名单并重新同步。');
    const { limit, offset } = parameters;
    if (offset > 0 && offset >= items.length) throw invalid();
    const end = Math.min(items.length, offset + limit);
    return { items: items.slice(offset, end), total: items.length, identityVersion,
      nextCursor: end < items.length ? Buffer.from(JSON.stringify({ kind, offset: end, identityVersion })).toString('base64url') : null };
  }

  roster(input: CompanionDirectoryInput = {}, options: { includeSummary?: boolean } = {}) {
    const parameters = this.parameters(input, 'roster');
    return this.snapshot((creators, _aliases, identityVersion) => {
      const page = this.page(creators, input, 'roster', identityVersion, parameters);
      return { ...page, items: page.items.map(creator => options.includeSummary !== false ? this.reader.summary(creator.creatorId) : {
        ...creator, collectedWorkCount: null, countPolicyVersion: COUNT_POLICY_VERSION,
        readModel: { status: 'permission_denied' as const, complete: false },
        dataVersion: fingerprint([creator.creatorId, identityVersion]), dataUpdatedAt: null, queriedAt: new Date().toISOString(),
      }) };
    });
  }

  aliases(input: CompanionDirectoryInput) {
    const parameters = this.parameters(input, 'aliases');
    return this.snapshot((_creators, aliases, identityVersion) => this.page(aliases, input, 'aliases', identityVersion, parameters));
  }
}
