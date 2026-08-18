'use client';

/**
 * The signed-in subject, and what they can do about it.
 *
 * The header's right-hand control: who am I, which tenant am I in, log out.
 * `tenant` is shown rather than tucked away because the same email can exist in
 * two clients (Doc 06 §8 — "same email creatable under two different clients"),
 * so "which PlantOps am I looking at" is a question the interface has to answer
 * without being asked.
 *
 * Extra rows go in `extraItems` — "My sessions" arrives with the session
 * screen, "Change password" with the profile screen — so this component never
 * grows a prop per feature.
 */

import { LogoutOutlined, MoonOutlined, SunOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Dropdown, Typography, type MenuProps } from 'antd';
import * as React from 'react';

import { spacing } from '../theme/tokens';

export interface UserMenuProps {
  /** Display name, falling back to the email when a user has no name yet. */
  name: string;
  /** The tenant's name or slug. */
  tenant?: string | null;
  /** Secondary line in the dropdown — normally the email. */
  subtitle?: string | null;
  onLogout: () => void;
  /** Colour-mode toggle. Omit to hide the row. */
  colorMode?: { mode: 'light' | 'dark'; onToggle: () => void };
  /** Rows inserted above the sign-out row. */
  extraItems?: MenuProps['items'];
}

/** Two initials from a display name — "Priya Nair" → "PN", "ops@x" → "OP". */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words.at(0) ?? '';
  const last = words.at(-1) ?? '';

  if (first === '') return '?';
  if (words.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first.slice(0, 1)}${last.slice(0, 1)}`.toUpperCase();
}

export function UserMenu({
  name,
  tenant,
  subtitle,
  onLogout,
  colorMode,
  extraItems,
}: UserMenuProps): React.ReactElement {
  const items: MenuProps['items'] = [
    {
      key: 'identity',
      type: 'group',
      label: (
        <span style={{ display: 'block', padding: `${spacing.xxs}px 0` }}>
          <Typography.Text strong style={{ display: 'block' }}>
            {name}
          </Typography.Text>
          {subtitle != null && subtitle !== '' && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {subtitle}
            </Typography.Text>
          )}
        </span>
      ),
    },
    { type: 'divider' },
    ...(extraItems ?? []),
    ...(colorMode === undefined
      ? []
      : [
          {
            key: 'color-mode',
            icon: colorMode.mode === 'dark' ? <SunOutlined /> : <MoonOutlined />,
            label: colorMode.mode === 'dark' ? 'Light appearance' : 'Dark appearance',
            onClick: colorMode.onToggle,
          },
        ]),
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: 'Sign out',
      danger: true,
      onClick: onLogout,
    },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      <button
        type="button"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacing.xs,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: `${spacing.xxs}px ${spacing.xs}px`,
          borderRadius: 6,
          color: 'inherit',
        }}
      >
        <Avatar size={30} style={{ background: 'var(--ant-color-primary)' }}>
          {name === '' ? <UserOutlined /> : initialsOf(name)}
        </Avatar>
        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            lineHeight: 1.2,
            maxWidth: 180,
          }}
        >
          <Typography.Text style={{ fontSize: 13 }} ellipsis>
            {name}
          </Typography.Text>
          {tenant != null && tenant !== '' && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
              {tenant}
            </Typography.Text>
          )}
        </span>
      </button>
    </Dropdown>
  );
}
