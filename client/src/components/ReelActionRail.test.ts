import { defineComponent, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as galleryApi from '../api/gallery';
import { createPinia, setActivePinia } from 'pinia';

import { useAuthStore } from '../stores/auth';
import { useLikesStore } from '../stores/likes';
import type { CanonicalWorkSummary, ReelItem } from '../types/api';
import ReelActionRail from './ReelActionRail.vue';

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
    folderId: 77,
    folderSlug: 'animal-planet',
    folderName: 'Animal Planet',
    folderPath: 'animal-planet',
    folderBreadcrumb: null,
    filename: `reel-${id}.mp4`,
    width: 1080,
    height: 1920,
    mediaType: 'video',
    durationMs: 21_000,
    thumbnailUrl: `/thumbs/${id}.webp`,
    previewUrl: `/previews/${id}.mp4`,
    sortTimestamp: 1_777_000_000_000 + id,
    takenAt: 1_777_000_000_000 + id
  };
}

function parentSummary(id:number):CanonicalWorkSummary {
  return {id,representation:'summary',folderId:77,folderSlug:'animal-planet',folderName:'Animal Planet',folderPath:'animal-planet',folderBreadcrumb:null,filename:'cover.jpg',carouselTitle:'Complete album',postType:'carousel',width:1200,height:1800,mediaType:'image',durationMs:null,thumbnailUrl:'/thumbs/parent-cover.webp',previewUrl:'/previews/parent-cover.webp',sortTimestamp:1777000000000,takenAt:null,itemCount:120,imageCount:117,videoCount:3};
}
const mountRail=(item:ReelItem)=>mount(ReelActionRail,{props:{item},global:{stubs:{RouterLink:{name:'RouterLink',props:['to'],template:'<a><slot /></a>'}}}});

describe('ReelActionRail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(galleryApi,'fetchPostSummary').mockImplementation(async id=>parentSummary(id));
    setActivePinia(createPinia());

    const authStore = useAuthStore();
    authStore.$patch({
      likesMode: 'local',
      capabilities: {
        canManageLibrary: false,
        canDeleteMedia: false,
        canAccessSettings: false,
        canUseSharedLikes: false,
        canUseLocalFavorites: true
      }
    });

    window.localStorage.clear();
  });

  it('does not bubble like clicks to a parent container', async () => {
    const likesStore = useLikesStore();
    const item = createReelItem(15);

    const TestHost = defineComponent({
      components: {
        ReelActionRail
      },
      setup() {
        const parentClicks = ref(0);
        return {
          item,
          parentClicks
        };
      },
      template: `
        <div data-test="parent" @click="parentClicks += 1">
          <ReelActionRail :item="item" />
          <output data-test="parent-count">{{ parentClicks }}</output>
        </div>
      `
    });

    const wrapper = mount(TestHost, {
      global: {
        stubs: {
          RouterLink: {
            name: 'RouterLink',
            props: ['to'],
            template: '<a data-test="folder-link"><slot /></a>'
          }
        }
      }
    });

    await wrapper.get('button[aria-label="Like post"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test="parent-count"]').text()).toBe('0');
    expect(likesStore.isLiked(item.postId)).toBe(true);
    expect(likesStore.isLiked(item.mediaId)).toBe(false);
    expect(likesStore.items[0]?.id).toBe(item.postId);
    expect(galleryApi.fetchPostSummary).toHaveBeenCalledExactlyOnceWith(item.postId);
    expect(likesStore.items[0]).toMatchObject({itemCount:120,imageCount:117,videoCount:3,thumbnailUrl:'/thumbs/parent-cover.webp',mediaType:'image'});
    const persisted=JSON.parse(window.localStorage.getItem('foldergram-local-favorites')!);
    expect(persisted).toEqual([parentSummary(item.postId)]);expect(persisted[0]).not.toHaveProperty('mediaId');expect(persisted[0]).not.toHaveProperty('mediaItems');
  });

  it('links back to the canonical album and synchronizes likes across its videos',async()=>{
    const item={...createReelItem(22),postId:900,creatorId:42,postType:'carousel' as const,mediaPosition:3};
    const wrapper=mount(ReelActionRail,{props:{item},global:{stubs:{RouterLink:{name:'RouterLink',props:['to'],template:'<a><slot /></a>'}}}});
    expect(wrapper.getComponent({name:'RouterLink'}).props('to')).toEqual({name:'canonical-work-gallery',params:{creatorId:'42',postId:'900'},query:{media:'22'}});
    await wrapper.get('button').trigger('click');await flushPromises();await wrapper.setProps({item:{...item,id:23,mediaId:23,mediaPosition:4}});
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true');expect(useLikesStore().likedIds).toEqual([900]);
    await wrapper.get('button').trigger('click');await flushPromises();expect(useLikesStore().likedIds).toEqual([]);expect(galleryApi.fetchPostSummary).toHaveBeenCalledTimes(1);
  });

  it('uses the canonical parent summary and parent post ID for shared likes',async()=>{
    useAuthStore().$patch({likesMode:'shared',capabilities:{canUseSharedLikes:true,canUseLocalFavorites:false}});
    const like=vi.spyOn(galleryApi,'likeImage').mockResolvedValue({id:900,liked:true,ok:true});
    const unlike=vi.spyOn(galleryApi,'unlikeImage').mockResolvedValue({id:900,liked:false,ok:true});
    const wrapper=mountRail({...createReelItem(22),postId:900});await wrapper.get('button').trigger('click');await flushPromises();
    expect(like).toHaveBeenCalledExactlyOnceWith(900);expect(useLikesStore().items[0]).toEqual(parentSummary(900));
    await wrapper.get('button').trigger('click');await flushPromises();expect(unlike).toHaveBeenCalledExactlyOnceWith(900);expect(galleryApi.fetchPostSummary).toHaveBeenCalledTimes(1);
  });

  it('does not store a reel or issue a like when parent loading fails or returns another identity',async()=>{
    vi.mocked(galleryApi.fetchPostSummary).mockRejectedValueOnce(new Error('Parent unavailable'));
    const wrapper=mountRail(createReelItem(22));await wrapper.get('button').trigger('click');await flushPromises();
    expect(wrapper.get('[role=status]').text()).toBe('Parent unavailable');expect(useLikesStore().items).toEqual([]);expect(window.localStorage.getItem('foldergram-local-favorites')).toBeNull();
    vi.mocked(galleryApi.fetchPostSummary).mockResolvedValueOnce(parentSummary(555));await wrapper.get('button').trigger('click');await flushPromises();expect(useLikesStore().items).toEqual([]);expect(galleryApi.fetchPostSummary).toHaveBeenCalledTimes(2);
  });

  it('ignores stale parent responses after switching albums and deduplicates clicks',async()=>{
    let finish!:(value:CanonicalWorkSummary)=>void;vi.mocked(galleryApi.fetchPostSummary).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
    const wrapper=mountRail(createReelItem(22));await wrapper.get('button').trigger('click');await wrapper.get('button').trigger('click');expect(galleryApi.fetchPostSummary).toHaveBeenCalledTimes(1);
    await wrapper.setProps({item:createReelItem(23)});finish(parentSummary(1022));await flushPromises();expect(useLikesStore().items).toEqual([]);
  });

  it('renders the download control between the info toggle and folder link', () => {
    const item = createReelItem(22);

    const wrapper = mount(ReelActionRail, {
      props: {
        item
      },
      global: {
        stubs: {
          RouterLink: {
            name: 'RouterLink',
            props: ['to'],
            template: '<a data-test="folder-link"><slot /></a>'
          }
        }
      }
    });

    const controls = wrapper.findAll('.reel-action-rail > *');

    expect(controls).toHaveLength(4);
    expect(controls[1]?.find('button[aria-label="Show reel details"]').exists()).toBe(true);

    const downloadLink = controls[2];

    expect(downloadLink?.attributes('aria-label')).toBe('Download original file');
    expect(downloadLink?.attributes('href')).toBe('/api/reels/media/22/original?v=fixed&download=1');
    expect(downloadLink?.attributes('title')).toBe('Download original file');
    expect(controls[3]?.attributes('data-test')).toBe('folder-link');
    expect(wrapper.getComponent({name:'RouterLink'}).props('to')).toEqual({name:'image',params:{id:'1022'},query:{media:'22',context:'work'}});
  });
});
