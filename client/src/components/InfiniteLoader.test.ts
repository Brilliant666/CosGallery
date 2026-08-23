import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InfiniteLoader from './InfiniteLoader.vue';

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  trigger(isIntersecting: boolean) {
    this.callback(
      [
        {
          isIntersecting
        } as IntersectionObserverEntry
      ],
      this as unknown as IntersectionObserver
    );
  }
}

describe('InfiniteLoader', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  it('hides the manual button when button fallback is disabled', () => {
    const wrapper = mount(InfiniteLoader, {
      props: {
        loading: false,
        hasMore: true,
        buttonFallback: false
      }
    });

    expect(wrapper.text()).not.toContain('Load more');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('keeps auto-loading while the sentinel remains visible', async () => {
    const wrapper = mount(InfiniteLoader, {
      props: {
        loading: false,
        hasMore: true,
        buttonFallback: false
      }
    });

    const observer = MockIntersectionObserver.instances[0];
    expect(observer).toBeDefined();

    observer.trigger(true);
    expect(wrapper.emitted('load-more')).toHaveLength(1);

    await wrapper.setProps({
      loading: true
    });
    await wrapper.setProps({
      loading: false
    });

    expect(wrapper.emitted('load-more')).toHaveLength(2);
  });
});
