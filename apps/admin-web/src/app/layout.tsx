/**
 * The document.
 *
 * A server component, deliberately: it renders the shell of the page and hands
 * off to `<Providers>` — the one client boundary — so that everything above it
 * stays static HTML.
 *
 * `<AntdRegistry>` is what stops the first paint being unstyled. antd 6 is
 * CSS-in-JS; without the registry the styles are generated in the browser after
 * hydration and the console flashes as raw markup first. The registry collects
 * them during the server render and inlines them into the response.
 */

import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata, Viewport } from 'next';
import type { ReactElement, ReactNode } from 'react';

import './global.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'PlantOps IAM',
  description:
    'Identity, access and the application registry behind every PlantOps module.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The sidebar keeps its dark surface in both colour modes, so the browser
  // chrome is told about both rather than being left to guess from the body.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EFF2F3' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1113' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
