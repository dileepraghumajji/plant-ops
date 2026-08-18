'use client';

/**
 * The top of every screen: what this is, and the actions that belong to it.
 *
 * A component rather than a convention because the *placement* of the primary
 * action is what makes a console feel like one product. Doc 09 §4 also puts a
 * requirement here that a hand-rolled header would keep forgetting: actions the
 * subject lacks permission for are hidden, so the action slot has to be the
 * kind of thing a caller can conditionally fill — hence `actions` as a node
 * rather than a button spec.
 */

import { Breadcrumb, Space, Typography } from 'antd';
import * as React from 'react';

import { spacing } from '../theme/tokens';

export interface PageHeaderProps {
  title: React.ReactNode;
  /** One sentence on what the screen is for. Worth writing. */
  description?: React.ReactNode;
  /** Trail above the title. Last entry is the current screen. */
  breadcrumbs?: { title: React.ReactNode; href?: string }[];
  /** Right-hand actions — normally one primary button and a menu. */
  actions?: React.ReactNode;
  /** Tabs or filters that belong to the header rather than the body. */
  footer?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  footer,
}: PageHeaderProps): React.ReactElement {
  return (
    <header style={{ marginBlockEnd: spacing.lg }}>
      {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
        <Breadcrumb
          items={breadcrumbs}
          style={{ marginBlockEnd: spacing.xs, fontSize: 12 }}
        />
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: spacing.md,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Typography.Title level={3} style={{ margin: 0, fontWeight: 600 }}>
            {title}
          </Typography.Title>
          {description !== undefined && (
            <Typography.Paragraph
              type="secondary"
              style={{ margin: `${spacing.xxs}px 0 0`, maxWidth: 720 }}
            >
              {description}
            </Typography.Paragraph>
          )}
        </div>
        {actions !== undefined && <Space wrap>{actions}</Space>}
      </div>
      {footer !== undefined && <div style={{ marginBlockStart: spacing.md }}>{footer}</div>}
    </header>
  );
}
