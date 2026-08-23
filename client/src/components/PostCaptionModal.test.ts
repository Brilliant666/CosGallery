import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, i18n } from '../locales';
import PostCaptionModal from './PostCaptionModal.vue';

describe('PostCaptionModal', () => {
  beforeEach(() => {
    i18n.global.locale.value = DEFAULT_LOCALE;
  });

  it('emits a trimmed caption when saving', async () => {
    const wrapper = mount(PostCaptionModal, {
      props: {
        filename: 'road-trip_001.jpg',
        caption: null
      }
    });

    await wrapper.get('textarea').setValue('  New caption  ');
    await wrapper.get('form').trigger('submit.prevent');

    expect(wrapper.emitted('save')).toEqual([['New caption']]);
  });

  it('resets to the filename fallback when saving the unchanged default caption', async () => {
    const wrapper = mount(PostCaptionModal, {
      props: {
        filename: 'road-trip_001.jpg',
        caption: null
      }
    });

    await wrapper.get('form').trigger('submit.prevent');

    expect(wrapper.emitted('save')).toEqual([[null]]);
  });

  it('emits null from the reset action when a custom caption exists', async () => {
    const wrapper = mount(PostCaptionModal, {
      props: {
        filename: 'road-trip_001.jpg',
        caption: 'Golden hour'
      }
    });

    await wrapper.get('button[type="button"]').trigger('click');

    expect(wrapper.emitted('save')).toEqual([[null]]);
  });

  it('refreshes the draft when the modal props change to a different post', async () => {
    const wrapper = mount(PostCaptionModal, {
      props: {
        filename: 'road-trip_001.jpg',
        caption: 'Golden hour'
      }
    });

    await wrapper.setProps({
      filename: 'city-walk_002.jpg',
      caption: null
    });

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('city walk 002');
  });

  it('renders translated Chinese labels', () => {
    i18n.global.locale.value = 'zh';

    const wrapper = mount(PostCaptionModal, {
      props: {
        filename: 'road-trip_001.jpg',
        caption: 'Golden hour'
      }
    });

    expect(wrapper.text()).toContain('编辑说明');
    expect(wrapper.text()).toContain('重置为文件名');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).placeholder).toBe('写点说明...');
  });
});
