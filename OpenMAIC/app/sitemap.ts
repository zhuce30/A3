import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://a3.zhuce.work';

  return [
    {
      url: `${siteUrl}/a3`,
      lastModified: new Date('2026-07-14'),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
