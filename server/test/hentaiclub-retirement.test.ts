import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ArchiveCatalogService } from '../src/services/archive-catalog-service.js';

const serverRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
describe('retired seed authority',()=>{
  it('has no callable HentaiClub seed importer or bootstrap command',()=>{
    const manifest=JSON.parse(fs.readFileSync(path.join(serverRoot,'package.json'),'utf8'));
    expect(manifest.scripts).not.toHaveProperty('import:hcf-tags');
    expect(manifest.scripts).not.toHaveProperty('catalog:bootstrap');
    expect(ArchiveCatalogService.prototype).not.toHaveProperty('importHentaiclubSeed');
    for(const file of ['scripts/import-hcf-tags.ts','scripts/archive-catalog-bootstrap.ts','services/creator-rating-import-service.ts']) {
      expect(fs.existsSync(path.join(serverRoot,'src',file))).toBe(false);
    }
  });
  it('has no normal runtime writes to the retired folder rating authority',()=>{
    for(const file of ['db/repositories.ts','services/managed-creator-service.ts','services/gallery-service.ts','routes/api.ts']) {
      const code=fs.readFileSync(path.join(serverRoot,'src',file),'utf8');
      expect(code).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+creator_rating_sources/i);
    }
    const startup=fs.readFileSync(path.join(serverRoot,'src/index.ts'),'utf8');
    expect(startup).not.toMatch(/importHentaiclubSeed|importHcf|import-hcf|hcf-tags/);
  });
});
