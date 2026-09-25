import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitepress';

const appPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
) as { version: string };

const guideItems = [
  { text: '快速开始', link: '/quick-start' },
  { text: '安装', link: '/installation' },
  { text: '配置', link: '/configuration' }
];

const productItems = [
  { text: '功能与边界', link: '/features' },
  { text: '页面地图', link: '/creator-admission-navigation' },
  { text: '本地入库与审核', link: '/local-admission-web' },
  { text: 'Costuan 入库', link: '/local-ingest-closed-loop' },
  { text: '来源资料与插件', link: '/source-evidence-local-admission' },
  { text: '自有资源目录', link: '/own-resource-catalog' }
];

const referenceItems = [
  { text: '架构与数据', link: '/how-it-works' },
  { text: '安全与备份', link: '/security' },
  { text: '应用恢复点', link: '/application-recovery-points' },
  { text: '开发', link: '/development' },
  { text: '排错', link: '/troubleshooting' },
  { text: '常见问题', link: '/faq' },
  { text: '技术与历史索引', link: '/reference-index' }
];

export default defineConfig({
  title: 'CosGallery',
  description: 'CosGallery 本机图库、资源目录与入库指南。',
  lang: 'zh-CN',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['style', {}, `:root { --foldergram-docs-version: ${JSON.stringify(`v${appPackage.version}`)}; }`]
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'CosGallery',
    search: {
      provider: 'local'
    },
    nav: [
      { text: '开始使用', link: '/quick-start' },
      { text: '用户指南', link: '/creator-admission-navigation' },
      { text: '配置', link: '/configuration' },
      { text: '维护与开发', link: '/reference-index' }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Brilliant666/CosGallery' }
    ],
    sidebar: [
      {
        text: '开始使用',
        items: guideItems
      },
      {
        text: '用户指南',
        items: productItems
      },
      {
        text: '维护与参考',
        items: referenceItems
      }
    ],
    outline: {
      level: [2, 3],
      label: '本页目录'
    },
    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: 'Copyright © 2026 Sajjad Ali'
    }
  }
});
