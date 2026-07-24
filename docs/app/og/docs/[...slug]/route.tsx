import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { OgCard } from '@/components/og-card';
import { normalizeDescription } from '@/lib/site';
import { getPageImage, source } from '@/lib/source';

export const revalidate = false;

interface RouteProps {
  params: Promise<{
    slug: string[];
  }>;
}

export async function GET(_request: Request, { params }: RouteProps) {
  const { slug } = await params;

  if (slug.at(-1) !== 'image.png') notFound();

  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <OgCard
      title={page.data.title}
      description={normalizeDescription(page.data.description)}
    />,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageImage(page).segments,
  }));
}
