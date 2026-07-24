import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { type NextRequest, NextResponse } from 'next/server';

const { rewrite: rewriteLLM } = rewritePath('/docs{/*path}', '/llms.mdx/docs{/*path}');

export default function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.endsWith('.md')) {
    return NextResponse.next();
  }

  if (isMarkdownPreferred(request)) {
    const rewrittenPath = rewriteLLM(request.nextUrl.pathname);

    if (rewrittenPath) {
      return NextResponse.rewrite(new URL(rewrittenPath, request.nextUrl));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/docs', '/docs/:path*'],
};
