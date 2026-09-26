import {describe, expect, it} from 'vitest';
import {applyCostuanRangeReview, costuanRangeReviewSchema, type CostuanRangeReview, type CostuanRangeReviewContext} from '../src/services/costuan-range-review.js';
import {parseCostuanDirectoryText} from '../src/services/costuan-numbering-service.js';

function fixture(creatorId = 901, postId = '8801', scheme = 'NO') {
  const collectionTitle = `Synthetic COSPLAY写真作品合集[4套][持续更新]`;
  const rawDirectoryText = `Synthetic ${scheme}.001 首套 [3P-2MB]\n${scheme}.002-${scheme}.004 合集 [90P-80MB]`;
  const review: CostuanRangeReview = {
    version: 1, creatorId, postId, collectionTitle, rawDirectoryText,
    approvedAt: '2026-09-26T10:00:00+08:00', reason: '逐个核对独立文件及已有来源条目',
    entries: [
      {sourceOrder: `${scheme}.001`, rawTitle: `Synthetic ${scheme}.001 首套 [3P-2MB]`, filename: '001.7z'},
      ...[2, 3, 4].map(number => ({sourceOrder: `${scheme}.00${number}`,
        rawTitle: `Synthetic ${scheme}.00${number} ${scheme}.00${number}（来源未提供标题）`, filename: `00${number}.7z`}))
    ]
  };
  const context: CostuanRangeReviewContext = {creatorId, postId, collectionTitle, rawDirectoryText,
    works: parseCostuanDirectoryText(rawDirectoryText)};
  return {review, context};
}

describe('server-owned explicit Costuan range review', () => {
  it.each([[901, '8801', 'NO'], [907, '8849', 'VOL']] as const)('uses the same contract for creator %s page %s scheme %s', (creatorId, postId, scheme) => {
    const {review, context} = fixture(creatorId, postId, scheme);
    const result = applyCostuanRangeReview(review, context);
    expect(result.works).toHaveLength(4);
    expect(result.works[0].declaredImageCount).toBe(3);
    expect(result.works.slice(1).map(work => work.declaredImageCount)).toEqual([null, null, null]);
    expect(result.rangeReview).toMatchObject({policy: 'explicit-range-v1', creatorId, postId,
      sourceOrders: [`${scheme}.002`, `${scheme}.003`, `${scheme}.004`], requiredFilenames: ['002.7z', '003.7z', '004.7z']});
    expect(result.rangeReview.reviewId).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.supplementalContents).toEqual([]);
    expect(applyCostuanRangeReview(review, {...context, works: result.works})).toEqual(result);
  });

  it('accepts explicit reviewed member titles, without inventing them from the aggregate', () => {
    const {review, context} = fixture();
    review.entries[1].rawTitle = 'Synthetic NO.002 独立核验的标题';
    expect(applyCostuanRangeReview(review, context).works[1].label).toBe('独立核验的标题');
  });

  it('supports another collection size and multiple ranges without creator-specific rules', () => {
    const {review, context} = fixture(930, '9980');
    review.collectionTitle = context.collectionTitle = 'Another COSPLAY写真作品合集[5套][持续更新]';
    review.rawDirectoryText = context.rawDirectoryText = 'NO.001-NO.002\nNO.003-NO.005';
    review.entries = [1, 2, 3, 4, 5].map(order => ({sourceOrder: `NO.00${order}`,
      rawTitle: `Another NO.00${order} 已审核标题${order}`, filename: `00${order}.7z`}));
    context.works = parseCostuanDirectoryText(context.rawDirectoryText);
    const result = applyCostuanRangeReview(review, context);
    expect(result.works).toHaveLength(5);
    expect(result.rangeReview.requiredFilenames).toEqual(['001.7z', '002.7z', '003.7z', '004.7z', '005.7z']);
  });

  it('normalizes formatting but preserves line boundaries and review identity', () => {
    const {review, context} = fixture();
    const expected = applyCostuanRangeReview(review, context);
    expect(applyCostuanRangeReview(review, {...context, rawDirectoryText: `  ${context.rawDirectoryText.replace('\n', '\r\n')}  `})).toEqual(expected);
    expect(() => applyCostuanRangeReview(review, {...context, rawDirectoryText: context.rawDirectoryText.replace('\n', ' ')})).toThrow();
  });

  it.each(['creatorId', 'postId', 'collectionTitle', 'rawDirectoryText'] as const)('rejects approvals replayed against changed %s', field => {
    const {review, context} = fixture();
    const changed = {...context, [field]: field === 'creatorId' ? 999 : `${context[field]} changed`};
    expect(() => applyCostuanRangeReview(review, changed)).toThrow();
  });

  it('rejects client flag shaped objects and missing approval attribution', () => {
    expect(costuanRangeReviewSchema.safeParse({approved: true, policy: 'explicit-range-v1'}).success).toBe(false);
    const {review, context} = fixture();
    expect(() => applyCostuanRangeReview({...review, reason: ''}, context)).toThrow();
    expect(() => applyCostuanRangeReview({...review, approvedAt: 'yesterday'}, context)).toThrow();
  });

  it.each(['missing', 'duplicate', 'other-number', 'range', 'title-number', 'changed-single', 'aggregate-media', 'filename', 'path', 'duplicate-filename'])('rejects invalid explicit entries: %s', mode => {
    const {review, context} = fixture();
    if (mode === 'missing') review.entries.pop();
    if (mode === 'duplicate') review.entries[3] = {...review.entries[2]};
    if (mode === 'other-number') review.entries[3].sourceOrder = 'NO.005';
    if (mode === 'range') review.entries[1].sourceOrder = 'NO.002-NO.004';
    if (mode === 'title-number') review.entries[1].rawTitle = 'Synthetic NO.003 other';
    if (mode === 'changed-single') review.entries[0].rawTitle = 'Synthetic NO.001 other [3P-2MB]';
    if (mode === 'aggregate-media') review.entries[1].rawTitle += ' [90P-80MB]';
    if (mode === 'filename') review.entries[1].filename = 'archive.7z';
    if (mode === 'path') review.entries[1].filename = '../002.7z';
    if (mode === 'duplicate-filename') review.entries[1].filename = '001.7z';
    expect(() => applyCostuanRangeReview(review, context)).toThrow();
  });

  it.each([
    'NO.001-NO.003\nNO.003-NO.004',
    'NO.001-NO.002\nNO.004 Last',
    'NO.001-NO.003\nVOL.004 Last',
    'NO.001-NO.004\n未知的目录说明',
    'NO.001-NO.004\nNO.002 重复',
    'NO.001-NO.005',
    'NO.001-NO.004\nSPECIAL extra [1P-1MB]'
  ])('rejects incomplete, overlapping, mixed or unknown raw declaration: %s', rawDirectoryText => {
    const {review, context} = fixture();
    review.rawDirectoryText = rawDirectoryText;
    context.rawDirectoryText = rawDirectoryText;
    context.works = parseCostuanDirectoryText(rawDirectoryText);
    expect(() => applyCostuanRangeReview(review, context)).toThrow();
  });

  it('does not let incoming client works add, omit or change approved entries', () => {
    const {review, context} = fixture();
    const works = applyCostuanRangeReview(review, context).works;
    for (const changed of [works.slice(1), [...works, works[0]],
      works.map((work, index) => index === 1 ? {...work, label: 'client changed'} : work),
      works.map((work, index) => index === 1 ? {...work, declaredImageCount: 90} : work),
      works.map((work, index) => index === 1 ? {...work, sourceOrderRaw: 'NO.003'} : work),
      works.map((work, index) => index === 1 ? {...work, rawTitle: 'Synthetic NO.002 client changed'} : work)]) {
      expect(() => applyCostuanRangeReview(review, {...context, works: changed})).toThrow();
    }
  });

  it('supports date headings but rejects omitted declaration lines', () => {
    const {review, context} = fixture();
    review.rawDirectoryText = `2025.01.01更新：\n${review.rawDirectoryText}`;
    context.rawDirectoryText = review.rawDirectoryText;
    expect(applyCostuanRangeReview(review, context).works).toHaveLength(4);
    review.rawDirectoryText += '\nNO.005';
    context.rawDirectoryText = review.rawDirectoryText;
    expect(() => applyCostuanRangeReview(review, context)).toThrow();
  });
});
