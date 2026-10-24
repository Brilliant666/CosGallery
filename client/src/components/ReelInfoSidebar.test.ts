import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchImage } from '../api/gallery';
import type { ReelItem, FolderSummary } from '../types/api';
import ReelInfoSidebar from './ReelInfoSidebar.vue';

vi.mock('../api/gallery', () => ({
  fetchImage: vi.fn()
}));

function createReelItem(id: number): ReelItem {
  return {
    id,
    mediaId: id,
    postId: id + 1000,
    mediaPosition: 1,
    creatorId: null,
    mimeType: 'video/mp4',
    fileSize: 24 * 1024 * 1024,
    originalDownloadUrl: `/api/reels/media/${id}/original?v=fixed&download=1`,
    folderId: 7,
    folderSlug: 'animal-planet',
    folderName: 'Animal Planet',
    folderPath: 'animals/big-cats',
    folderBreadcrumb: 'Animals / Big Cats',
    filename: `snow-leopard-${id}.mp4`,
    width: 1080,
    height: 1920,
    mediaType: 'video',
    durationMs: 21_000,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.mp4`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id,
    caption: null
  };
}

function createFolder(): FolderSummary {
  return {
    id: 7,
    slug: 'animal-planet',
    name: 'Animal Planet',
    description: 'Wildlife clips from the archive.',
    folderPath: 'animals/big-cats',
    breadcrumb: 'Animals / Big Cats',
    imageCount: 0,
    videoCount: 3,
    latestImageMtimeMs: null,
    avatarImageId: null,
    avatarUrl: null
  };
}

describe('ReelInfoSidebar', () => {
  beforeEach(() => {setActivePinia(createPinia());vi.mocked(fetchImage).mockReset();});
  const sidebar=(item:ReelItem,open=true)=>mount(ReelInfoSidebar,{props:{item,folder:createFolder(),open},global:{stubs:{Avatar:{template:'<div />'},RouterLink:{template:'<a><slot /></a>'}}}});
  it('uses current video metadata without fetching the parent post or all album media',async()=>{
    const item={...createReelItem(11),postId:999,mediaPosition:3,postType:'carousel' as const,caption:'Parent album description'};
    const wrapper=sidebar(item);await flushPromises();
    expect(fetchImage).not.toHaveBeenCalled();expect(wrapper.text()).toContain('MP4');expect(wrapper.text()).toContain('24.00 MB');expect(wrapper.text()).toContain('1080 x 1920');expect(wrapper.text()).toContain('Parent album description');expect(wrapper.text()).toContain('parent media entry or album');
    await wrapper.setProps({item:{...item,id:12,mediaId:12,mediaPosition:4,width:1920,height:1080,fileSize:5*1024*1024,mimeType:'video/webm'}});await flushPromises();
    expect(wrapper.text()).toContain('1920 x 1080');expect(wrapper.text()).toContain('5.00 MB');expect(wrapper.text()).toContain('WEBM');expect(fetchImage).not.toHaveBeenCalled();
  });
  it('does not fetch details on reopening and honors right-side anchoring',async()=>{
    const wrapper=sidebar(createReelItem(14),false);await wrapper.setProps({open:true,anchor:'right'});await flushPromises();
    expect(wrapper.get('.reels-info-sidebar').classes()).toContain('reels-info-sidebar--anchor-right');expect(fetchImage).not.toHaveBeenCalled();
  });
  it('uses parent album title after clearing its caption',async()=>{
    const item={...createReelItem(21),postType:'carousel' as const,carouselTitle:'Album A',caption:'Old caption'};
    const wrapper=sidebar(item);expect(wrapper.text()).toContain('Old caption');await wrapper.setProps({item:{...item,caption:null}});expect(wrapper.text()).toContain('Album A');expect(wrapper.text()).not.toContain('Old caption');
  });
});
