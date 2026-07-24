import { absoluteUrl, normalizeDescription } from '@/lib/site';
import { source } from '@/lib/source';

export async function getLLMText(page: (typeof source)['$inferPage']): Promise<string> {
  const processed = await page.data.getText('processed');
  const description = normalizeDescription(page.data.description);

  return [
    `# ${page.data.title}`,
    '',
    description ? `> ${description}` : undefined,
    description ? '' : undefined,
    `Canonical: ${absoluteUrl(page.url)}`,
    '',
    processed.trim(),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
