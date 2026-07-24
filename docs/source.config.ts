import {
  createFileSystemGeneratorCache,
  createGenerator,
  remarkAutoTypeTable,
  type GeneratedDoc,
} from 'fumadocs-typescript';
import type { LLMsOptions } from 'fumadocs-core/mdx-plugins/remark-llms';
import { pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { z } from 'zod';

const typeGenerator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/fumadocs-typescript'),
  tsconfigPath: '../packages/natui/tsconfig.json',
});

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function formatTypeTable(doc: GeneratedDoc): string {
  const rows = doc.entries.map((entry) => {
    const description = entry.deprecated
      ? `Deprecated. ${entry.description}`
      : entry.description;

    return `| \`${escapeTableCell(entry.name)}\` | \`${escapeTableCell(entry.type)}\` | ${entry.required ? 'Yes' : 'No'} | ${escapeTableCell(description)} |`;
  });

  return [
    `### ${doc.name}`,
    '',
    doc.description?.trim(),
    doc.description?.trim() ? '' : undefined,
    '| Property | Type | Required | Description |',
    '| --- | --- | --- | --- |',
    ...rows,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

const llmsOptions: LLMsOptions = {
  stringify(node) {
    if (node.type !== 'mdxJsxFlowElement' || node.name !== 'TypeTable') return;

    const typeAttribute = node.attributes.find(
      (attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === 'type',
    );

    if (
      !typeAttribute ||
      typeAttribute.type !== 'mdxJsxAttribute' ||
      !typeAttribute.value ||
      typeof typeAttribute.value === 'string'
    ) {
      return;
    }

    try {
      return formatTypeTable(JSON.parse(typeAttribute.value.value) as GeneratedDoc);
    } catch {
      return;
    }
  },
};

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema.extend({
      description: z.string().trim().min(1),
    }),
    postprocess: {
      includeProcessedMarkdown: llmsOptions,
    },
  },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [[remarkAutoTypeTable, { generator: typeGenerator }]],
  },
});
