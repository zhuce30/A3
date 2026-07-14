import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://a3.zhuce.work';

  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/a3'],
      disallow: ['/a3/', '/api/', '/admin/'],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
