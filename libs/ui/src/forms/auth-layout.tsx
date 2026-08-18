'use client';

/**
 * The page a signed-out person sees: a centred card on a branded field.
 *
 * Shared with the consoles that come later so that sign-in, password reset and
 * "your session ended" all look like the same door into the same product. The
 * card is the only thing on the page — an unauthenticated visitor has exactly
 * one thing to do, and every additional element is a way to not do it.
 */

import { Card, Typography } from 'antd';
import * as React from 'react';

import { Brand } from '../layout/brand';
import { navSurface, palette, spacing } from '../theme/tokens';

export interface AuthLayoutProps {
  children: React.ReactNode;
  /** The console's name, beside the mark — "IAM", "Gatepass". */
  product?: string;
  title?: string;
  subtitle?: React.ReactNode;
  /** Small print under the card — an environment badge, a support address. */
  footer?: React.ReactNode;
}

export function AuthLayout({
  children,
  product,
  title = 'Sign in',
  subtitle,
  footer,
}: AuthLayoutProps): React.ReactElement {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.lg,
        padding: spacing.lg,
        // A single wash rather than an image: it renders identically on every
        // deployment, costs no request, and cannot be the asset someone forgot
        // to copy into the container.
        background: `radial-gradient(1200px 600px at 50% -10%, ${palette.primary}22, transparent 60%), ${navSurface.background}`,
      }}
    >
      <Brand product={product} />

      <Card
        style={{ width: '100%', maxWidth: 420 }}
        styles={{ body: { padding: spacing.xl } }}
      >
        <Typography.Title level={4} style={{ marginBlockStart: 0 }}>
          {title}
        </Typography.Title>
        {subtitle !== undefined && (
          <Typography.Paragraph type="secondary" style={{ marginBlockEnd: spacing.lg }}>
            {subtitle}
          </Typography.Paragraph>
        )}
        {children}
      </Card>

      {footer !== undefined && (
        <Typography.Text style={{ color: navSurface.text, fontSize: 12 }}>
          {footer}
        </Typography.Text>
      )}
    </main>
  );
}
