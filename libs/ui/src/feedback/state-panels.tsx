'use client';

/**
 * The four things a screen shows when it is not showing data: loading, empty,
 * denied, broken.
 *
 * Written once because they are the states screens get wrong. Left to each
 * page, "denied" becomes a blank area, "empty" becomes a spinner that never
 * stops, and the difference between "you have no users yet" and "you may not
 * see users" — which are opposite messages with opposite next actions —
 * disappears.
 *
 * {@link ScreenError} is the one that matters most. Doc 09 §4 requires the
 * console to render a 403 cleanly on a deep link into a screen the menu hid,
 * because client-side hiding is UX and the server is the enforcement. That is
 * this component with the copy from `error-copy.ts`.
 */

import {
  ExclamationCircleOutlined,
  InboxOutlined,
  LockOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Result, Skeleton, Space, Spin, Typography } from 'antd';
import * as React from 'react';

import { spacing } from '../theme/tokens';
import { type ErrorCopy, type ErrorTone } from './error-copy';

export interface ScreenLoadingProps {
  /** `'panel'` for a first paint, `'inline'` for a refresh inside a screen. */
  variant?: 'panel' | 'inline';
  /** Rows of skeleton text, for a variant that stands in for known content. */
  rows?: number;
  label?: string;
}

export function ScreenLoading({
  variant = 'panel',
  rows = 4,
  label,
}: ScreenLoadingProps): React.ReactElement {
  if (variant === 'inline') {
    return (
      <Space size="small" style={{ padding: spacing.md }}>
        <Spin size="small" />
        {label !== undefined && (
          <Typography.Text type="secondary">{label}</Typography.Text>
        )}
      </Space>
    );
  }
  return (
    <div style={{ padding: spacing.lg }} aria-busy="true" aria-live="polite">
      <Skeleton active paragraph={{ rows }} title />
    </div>
  );
}

export interface ScreenEmptyProps {
  title?: string;
  description?: React.ReactNode;
  /** The one thing to do about it — "Add the first user". */
  action?: React.ReactNode;
}

export function ScreenEmpty({
  title = 'Nothing here yet',
  description,
  action,
}: ScreenEmptyProps): React.ReactElement {
  return (
    <Result
      icon={<InboxOutlined style={{ color: 'var(--ant-color-text-quaternary)' }} />}
      title={title}
      subTitle={description}
      extra={action}
    />
  );
}

const TONE_ICON: Readonly<Record<ErrorTone, React.ReactNode>> = {
  error: <ExclamationCircleOutlined style={{ color: 'var(--ant-color-error)' }} />,
  warning: <StopOutlined style={{ color: 'var(--ant-color-warning)' }} />,
  info: <LockOutlined style={{ color: 'var(--ant-color-info)' }} />,
};

export interface ScreenErrorProps {
  /** From `errorCopyFor(code)` — the words. */
  copy: ErrorCopy;
  /**
   * The server's own message, shown under the copy when it adds something.
   *
   * Kept because a `CONFLICT` whose message names the duplicate field is far
   * more useful than the generic sentence, and suppressed when it is only a
   * restatement.
   */
  detail?: string | null;
  /** Correlates with the server's logs and audit trail (Doc 06 §2). */
  requestId?: string | null;
  /** Field-level complaints from a `VALIDATION_FAILED`. */
  details?: readonly { field: string; message: string }[];
  /** Shown only when the failure is plausibly transient. */
  onRetry?: () => void;
  /** An escape route — "Back to the dashboard". */
  action?: React.ReactNode;
}

/**
 * A failed screen, explained.
 *
 * `requestId` is rendered in a monospace, selectable line rather than hidden in
 * a console: it is the only handle an operator has for finding this exact
 * failure in the server's logs and audit trail, and the person who can read it
 * out is the one looking at the screen.
 */
export function ScreenError({
  copy,
  detail,
  requestId,
  details,
  onRetry,
  action,
}: ScreenErrorProps): React.ReactElement {
  const showDetail =
    detail != null && detail.trim() !== '' && detail.trim() !== copy.description;

  return (
    <Result
      icon={TONE_ICON[copy.tone]}
      title={copy.title}
      subTitle={
        <Space direction="vertical" size={spacing.xs} style={{ maxWidth: 620 }}>
          <Typography.Text type="secondary">{copy.description}</Typography.Text>
          {showDetail && (
            <Typography.Text type="secondary" italic>
              {detail}
            </Typography.Text>
          )}
          {details !== undefined && details.length > 0 && (
            <ul style={{ margin: 0, paddingInlineStart: spacing.lg, textAlign: 'start' }}>
              {details.map((item) => (
                <li key={`${item.field}:${item.message}`}>
                  <Typography.Text type="secondary">
                    <strong>{item.field}</strong> — {item.message}
                  </Typography.Text>
                </li>
              ))}
            </ul>
          )}
          {requestId != null && requestId !== '' && (
            <Typography.Text
              type="secondary"
              copyable={{ text: requestId }}
              style={{ fontFamily: 'var(--ant-font-family-code)', fontSize: 12 }}
            >
              Request {requestId}
            </Typography.Text>
          )}
        </Space>
      }
      extra={
        <Space>
          {action}
          {copy.retryable && onRetry !== undefined && (
            <Button icon={<ReloadOutlined />} onClick={onRetry}>
              Try again
            </Button>
          )}
        </Space>
      }
    />
  );
}
