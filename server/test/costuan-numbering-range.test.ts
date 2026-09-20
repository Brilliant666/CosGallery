import { describe, expect, it } from 'vitest';
import { hasCostuanNumberRangeSyntax, parseCostuanNumberRange } from '../src/services/costuan-numbering-range.js';

describe('Costuan range coverage declarations', () => {
  it.each(['NO.018-NO.26', 'NO.018-026', 'no.018 ～ 026', 'ＮＯ．０１８－ＮＯ．２６', 'NO.018至026'])('normalizes %s without expanding works', value => {
    const result = parseCostuanNumberRange(value)!;
    expect(result).toMatchObject({ scheme: 'NO', first: 18, last: 26, count: 9, key: 'RANGE:NO:018-026', canonicalLabel: 'NO.018-NO.026' });
    expect(result).not.toHaveProperty('works');
    expect(result).not.toHaveProperty('filenames');
  });
  it('retains text offsets and distinguishes Vol ranges', () => {
    const text = 'Shika小鹿鹿 NO.027～028 日系 2';
    const range = parseCostuanNumberRange(text)!;
    expect(range).toMatchObject({ first: 27, last: 28, count: 2, rawLabel: 'NO.027~028' });
    expect(text.normalize('NFKC').slice(range.start, range.end)).toBe(range.rawLabel);
    expect(parseCostuanNumberRange('VOL.003–VOL.005')).toMatchObject({ scheme: 'VOL', count: 3, key: 'RANGE:VOL:003-005' });
  });
  it.each(['NO.026-018', 'NO.018-018', 'NO.000-018', 'NO.001-10000', 'NO.018-VOL.026', 'NO.018-', 'NO.018-NO.', 'NO.018-NO.foo', 'NO.018-026-028', 'NO.018-026 NO.030-035'])('rejects malformed or ambiguous range %s without first-number fallback', value => {
    expect(hasCostuanNumberRangeSyntax(value)).toBe(true);
    expect(() => parseCostuanNumberRange(value)).toThrow();
  });
  it.each(['NO.001 女仆 NO.018-NO.026 日系', 'NO.001 女仆 VOL.018-VOL.026', 'Maruemon 001 [UNKNOWN] Vol.150-151', 'NO.001 [ARTGRAVIA] NO.018-NO.026'])('rejects a later ambiguous collection range: %s', value => {
    expect(() => parseCostuanNumberRange(value)).toThrow('歧义');
    expect(() => hasCostuanNumberRangeSyntax(value)).toThrow('歧义');
  });
  it.each(['NO.018 女仆', 'NO.018 - 女仆', 'Maruemon 001 [ARTGRAVIA] Vol.150', 'NO.001 [ARTGRAVIA] Vol.150', 'Maruemon 001 [ARTGRAVIA] Vol.150-151', 'NO.001 [ARTGRAVIA] Vol.150-151', 'photo 018-026', '标题2021-2023', 'NO.018 [18P-26MB]'])('does not treat unrelated title numbers as a range: %s', value => {
    expect(parseCostuanNumberRange(value)).toBeNull();
  });
});
