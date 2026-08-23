import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { watch } from 'vue';

import './custom.css';
import './rainbow.css';

let homePageStyle: HTMLStyleElement | undefined;

function updateHomePageStyle(value: boolean) {
  if (typeof document === 'undefined') {
    return;
  }

  if (value) {
    if (homePageStyle)
      return

    homePageStyle = document.createElement('style')
    homePageStyle.innerHTML = `
    :root {
      animation: rainbow 40s linear -14s infinite;
    }`
    document.head.appendChild(homePageStyle)
    document.documentElement.classList.add('rainbow')
  } else {
    if (!homePageStyle)
      return

    homePageStyle.remove()
    homePageStyle = undefined
    document.documentElement.classList.remove('rainbow')
  }
}

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === 'undefined') {
      return;
    }

    watch(
      () => router.route.data.relativePath,
      (relativePath) => {
        updateHomePageStyle(relativePath === 'index.md' || relativePath === '');
      },
      { immediate: true }
    );
  }
};

export default theme;
