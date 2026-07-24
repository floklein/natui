import { ImageResponse } from 'next/og';
import { OgCard } from '@/components/og-card';
import { siteDescription, siteTitle } from '@/lib/site';

export const revalidate = false;

export function GET() {
  return new ImageResponse(
    <OgCard title={siteTitle} description={siteDescription} />,
    {
      width: 1200,
      height: 630,
    },
  );
}
