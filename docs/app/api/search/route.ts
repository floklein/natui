import { createFromSource } from 'fumadocs-core/search/server';
import type { GeneratedDoc } from 'fumadocs-typescript';
import { source } from '@/lib/source';

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(quot|apos|lt|gt|amp));/gi,
    (entity, hex, decimal, named) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));

      const values: Record<string, string> = {
        quot: '"',
        apos: "'",
        lt: '<',
        gt: '>',
        amp: '&',
      };
      return values[String(named).toLowerCase()] ?? entity;
    },
  );
}

function readGeneratedDoc(content: string): GeneratedDoc | undefined {
  const value = /\btype="([\s\S]*?)"\s*\/?>/.exec(content)?.[1];
  if (!value) return;

  try {
    return JSON.parse(decodeHtmlEntities(value)) as GeneratedDoc;
  } catch {
    return;
  }
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function buildSearchIndex(page: (typeof source)['$inferPage']) {
  const structuredData = page.data.structuredData;

  return {
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    structuredData: {
      ...structuredData,
      contents: structuredData.contents.flatMap((entry) => {
        if (!entry.content.includes('<TypeTable')) return [entry];

        const doc = readGeneratedDoc(entry.content);
        if (!doc) return [];

        const summary = normalizeSearchText(
          [doc.name, doc.description].filter(Boolean).join(': '),
        );
        const properties = doc.entries.map((property) => ({
          ...entry,
          content: normalizeSearchText(
            `${doc.name}.${property.name}: ${property.type}. ${property.description ?? ''}`,
          ),
        }));

        return summary ? [{ ...entry, content: summary }, ...properties] : properties;
      }),
    },
  };
}

export const { GET } = createFromSource(source, {
  language: 'english',
  buildIndex: buildSearchIndex,
});
