import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { NatuiMark } from '@/components/natui-mark';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="docs-wordmark">
          <span aria-hidden="true" className="docs-wordmark-mark">
            <NatuiMark size={13} />
          </span>
          NatUI
        </span>
      ),
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs',
        active: 'nested-url',
      },
      {
        text: 'GitHub',
        url: 'https://github.com/floklein/natui',
        external: true,
      },
    ],
  };
}
