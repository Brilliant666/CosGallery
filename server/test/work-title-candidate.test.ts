import { describe, expect, it } from 'vitest';
import { isWorkTitleCandidate, workTitleCandidateKey } from '../src/utils/work-title-candidate.js';
import { normalizeWorkTitle } from '../src/utils/work-title.js';

describe('lossy source/local review suggestions are not identities', () => {
  const names = ['ModelName', '모델'];
  it.each([
    ['1 - [Studio] Summer', '[Studio] Summer'],
    ['Model Name 015 [Studio] Summer', '[Studio] Summer'],
    ['Model Name(모델) NO.018 [Studio]Summer [61P/766MB]', '[Studio]Summer'],
    ['12 - [Studio] Model Name (모델) x JOA 20. APR Vol.1', '[Studio] x JOA 20. APR Vol.1'],
    ["14 - [Studio] Model's Day 2", '[Studio] Model’s Day 2'],
  ])('suggests %s for review without changing exact normalization', (local, source) => {
    expect(isWorkTitleCandidate(local, source, names)).toBe(true);
    expect(normalizeWorkTitle(local, names)).not.toBe(normalizeWorkTitle(source, names));
  });
  it.each([
    ['ModelNameish Summer', 'Summer'],
    ['UnknownPerson NO.018 Summer', 'Summer'],
    ['1 - Studio VOL201', 'Studio VOL202'],
    ['1 - Day 2', 'Day 3'],
    ['Nurse Night', 'Nurse Night Special'],
  ])('keeps distinct evidence %s / %s', (local, source) => {
    expect(isWorkTitleCandidate(local, source, names)).toBe(false);
  });
  it('does not turn an empty or numbered-only key into an identity', () => {
    expect(workTitleCandidateKey('001 - ', names)).toBe('');
    expect(isWorkTitleCandidate('001 - ', '002 - ', names)).toBe(false);
  });
});
