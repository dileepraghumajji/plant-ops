'use client';

/**
 * The product mark at the top of the sidebar.
 *
 * A component rather than an `<img>` because every console in this monorepo
 * shows the *same* PlantOps mark with a *different* word beside it — "IAM",
 * "Gatepass", "Visitor" — and the thing that must not drift between them is the
 * mark, not the word. Passing `product` keeps the drift impossible.
 *
 * The mark is inline SVG: a shared library that fetches an image from a path
 * only some of its consumers serve is a broken logo waiting for the first
 * deployment that does not copy the asset.
 */

import { Typography } from 'antd';
import * as React from 'react';

import { navSurface, palette, spacing } from '../theme/tokens';

export interface BrandProps {
  /** The console's name — "IAM", "Gatepass". Hidden when collapsed. */
  product?: string;
  /** Icon-only, for the collapsed rail. */
  collapsed?: boolean;
  onClick?: () => void;
}

/**
 * The mark: three stacked bars narrowing upward inside a rounded square — a
 * process vessel read from the side, which is as close to "plant operations"
 * as an 20px glyph gets without becoming a picture of a factory.
 */
function Mark({ size = 28 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="PlantOps"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill={palette.primary} />
      <rect x="8" y="8" width="16" height="4" rx="2" fill="#FFFFFF" />
      <rect x="10" y="14" width="12" height="4" rx="2" fill="#FFFFFF" opacity="0.8" />
      <rect x="12" y="20" width="8" height="4" rx="2" fill="#FFFFFF" opacity="0.6" />
    </svg>
  );
}

export function Brand({
  product,
  collapsed = false,
  onClick,
}: BrandProps): React.ReactElement {
  const content = (
    <>
      <Mark />
      {!collapsed && (
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            lineHeight: 1.15,
            minWidth: 0,
          }}
        >
          <Typography.Text
            strong
            style={{ color: navSurface.textSelected, fontSize: 15 }}
          >
            PlantOps
          </Typography.Text>
          {product !== undefined && (
            <Typography.Text
              style={{ color: navSurface.text, fontSize: 11, letterSpacing: 0.6 }}
            >
              {product.toUpperCase()}
            </Typography.Text>
          )}
        </span>
      )}
    </>
  );

  const style: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.sm,
    height: 56,
    padding: `0 ${collapsed ? spacing.md : spacing.lg}px`,
    background: 'transparent',
    border: 'none',
    width: '100%',
    cursor: onClick === undefined ? 'default' : 'pointer',
    overflow: 'hidden',
  };

  if (onClick === undefined) {
    return <div style={style}>{content}</div>;
  }
  return (
    <button type="button" onClick={onClick} style={style}>
      {content}
    </button>
  );
}
