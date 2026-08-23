import { describe, expect, it } from 'vitest';

import { formatFolderTitle } from './folder-titles';

describe('formatFolderTitle', () => {
  it('returns the raw folder name when the default format is selected', () => {
    expect(
      formatFolderTitle(
        {
          name: '2022',
          breadcrumb: 'Italy',
          folderPath: 'Italy/2022'
        },
        'folder'
      )
    ).toBe('2022');
  });

  it('prefixes nested folders with their immediate parent when requested', () => {
    expect(
      formatFolderTitle(
        {
          name: '2022',
          breadcrumb: 'Trips / Italy',
          folderPath: 'Trips/Italy/2022'
        },
        'parent-plus-folder'
      )
    ).toBe('Italy - 2022');
  });

  it('prefers the parent folder display name when one is provided', () => {
    expect(
      formatFolderTitle(
        {
          name: '2022',
          parentFolderName: 'Italia',
          breadcrumb: 'Italy',
          folderPath: 'Italy/2022'
        },
        'parent-plus-folder'
      )
    ).toBe('Italia - 2022');
  });

  it('falls back to folderPath when breadcrumb is unavailable', () => {
    expect(
      formatFolderTitle(
        {
          folderName: '2022',
          folderBreadcrumb: null,
          folderPath: 'Spain/2022'
        },
        'parent-plus-folder'
      )
    ).toBe('Spain - 2022');
  });

  it('keeps top-level folders unchanged when there is no parent folder', () => {
    expect(
      formatFolderTitle(
        {
          folderName: '2022',
          folderParentName: null,
          folderBreadcrumb: null,
          folderPath: '2022'
        },
        'parent-plus-folder'
      )
    ).toBe('2022');
  });
});
