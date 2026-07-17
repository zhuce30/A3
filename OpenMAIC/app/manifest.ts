import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '智学引擎',
    short_name: '智学引擎',
    description: '面向大学生的个性化学习闭环产品',
    start_url: '/a3',
    display: 'standalone',
    background_color: '#0b0f0d',
    theme_color: '#b7f34a',
    lang: 'zh-CN',
    icons: [
      {
        src: '/a3-brand-icon.png',
        sizes: '1024x1024',
        type: 'image/png',
      },
    ],
  };
}
