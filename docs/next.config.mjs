import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/docs',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
      {
        source: '/docs/:path*',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
      {
        source: '/llms.mdx/docs',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
      {
        source: '/llms.mdx/docs/:path*',
        headers: [{ key: 'Vary', value: 'Accept' }],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/docs.md',
        destination: '/llms.mdx/docs',
      },
      {
        source: '/docs/:path*.md',
        destination: '/llms.mdx/docs/:path*',
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(config);
