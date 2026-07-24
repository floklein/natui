import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { absoluteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteUrl('/'),
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...source.getPages().map((page) => ({
      url: absoluteUrl(page.url),
      changeFrequency: 'weekly' as const,
      priority: page.url === '/docs' ? 0.9 : 0.7,
    })),
  ];
}
