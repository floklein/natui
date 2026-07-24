import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
} from 'fumadocs-ui/layouts/docs/page';
import { getMDXComponents } from '@/components/mdx';
import { absoluteUrl, normalizeDescription } from '@/lib/site';
import { getPageImage, source } from '@/lib/source';

// HTML and Markdown share the public URL through Accept negotiation. Rendering
// HTML on demand lets the response retain Vary: Accept instead of serving a
// prerender-cache header set that omits the negotiated media type.
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{
    slug?: string[];
  }>;
}

export default async function DocumentationPage({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const Content = page.data.body;
  const markdownUrl = `${page.url}.md`;
  const sourceUrl = `https://github.com/floklein/natui/blob/main/docs/content/docs/${page.path}`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="page-actions" aria-label="Page actions">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <a className="page-action" href={markdownUrl} target="_blank" rel="noreferrer">
          View Markdown
        </a>
        <a className="page-action" href={sourceUrl} target="_blank" rel="noreferrer">
          View source
        </a>
      </div>
      <DocsBody>
        <Content
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const image = getPageImage(page);
  const imageAlt = `natui documentation: ${page.data.title}`;
  const description = normalizeDescription(page.data.description);

  return {
    title: page.data.title,
    description,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      type: 'website',
      url: absoluteUrl(page.url),
      title: page.data.title,
      description,
      images: [
        {
          url: image.url,
          width: 1200,
          height: 630,
          alt: imageAlt,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description,
      images: [
        {
          url: image.url,
          alt: imageAlt,
        },
      ],
    },
  };
}

export function generateStaticParams() {
  return source.generateParams();
}
