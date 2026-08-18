'use client';

/**
 * One vocabulary for "what state is this row in".
 *
 * The IAM has four independent status enums — user (`active`/`locked`/
 * `disabled`), client (`active`/`suspended`), service account (`active`/
 * `revoked`) and the derived expired-binding flag — and they mean roughly the
 * same three things. Rendering each with its own ad-hoc colour is how a console
 * ends up showing `disabled` in red on one screen and grey on the next, which
 * quietly teaches an admin that the colour means nothing.
 *
 * So: statuses map to a small set of *tones*, and the tone decides the colour.
 * Unknown values render neutrally with their own label rather than throwing,
 * because a status enum can gain a member in a migration long before this file
 * hears about it.
 */

import { Tag } from 'antd';
import * as React from 'react';

/** What a state means to the person reading the row. */
export type StatusTone = 'good' | 'attention' | 'stopped' | 'neutral';

const TONE_COLOR: Readonly<Record<StatusTone, string>> = {
  good: 'green',
  attention: 'gold',
  stopped: 'red',
  neutral: 'default',
};

/**
 * Status string → tone.
 *
 * `locked` is `attention` rather than `stopped` on purpose: it is reversible by
 * an administrator in one click, where `disabled` and `revoked` are decisions.
 */
const TONE_FOR_STATUS: Readonly<Record<string, StatusTone>> = {
  active: 'good',
  enabled: 'good',
  locked: 'attention',
  pending: 'attention',
  expiring: 'attention',
  disabled: 'stopped',
  suspended: 'stopped',
  revoked: 'stopped',
  expired: 'stopped',
  inactive: 'neutral',
};

export interface StatusTagProps {
  /** The raw enum value from the API. */
  status: string;
  /** Overrides the derived tone — for a state whose meaning is screen-specific. */
  tone?: StatusTone;
  /** Overrides the label. Defaults to the status, capitalised. */
  label?: string;
}

export function statusTone(status: string): StatusTone {
  return TONE_FOR_STATUS[status.toLowerCase()] ?? 'neutral';
}

export function StatusTag({ status, tone, label }: StatusTagProps): React.ReactElement {
  const resolved = tone ?? statusTone(status);
  const text = label ?? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
  return (
    <Tag color={TONE_COLOR[resolved]} style={{ marginInlineEnd: 0 }}>
      {text}
    </Tag>
  );
}
