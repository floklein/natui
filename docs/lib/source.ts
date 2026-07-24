import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';

const componentPagePrefix = '/docs/components/';
const componentSuffix = / components$/i;

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [
      {
        file(node) {
          if (node.url === '/docs') {
            return {
              ...node,
              name: 'Introduction',
            };
          }

          if (
            node.url.startsWith(componentPagePrefix) &&
            typeof node.name === 'string'
          ) {
            return {
              ...node,
              name: node.name.replace(componentSuffix, ''),
            };
          }

          return node;
        },
      },
    ],
  },
});

export function getPageImage(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `/og/docs/${segments.map(encodeURIComponent).join('/')}`,
  };
}
