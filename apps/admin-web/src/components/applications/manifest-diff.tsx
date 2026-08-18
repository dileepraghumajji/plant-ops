'use client';

/**
 * The diff an upload would apply, rendered for a person to approve
 * (Doc 09 §2.1, Doc 02 §7).
 *
 * ## Why this takes the document as well as the diff
 *
 * `ManifestDiff` is a list of keys. That is the right shape for the API and for
 * the audit payload it doubles as — a diff has to stay readable long after the
 * manifest that produced it was overwritten, and a label captured at upload time
 * would be a stale label forever (`contracts/manifest.ts`). But `dc.approvals`
 * on its own does not tell an operator whether they are about to add "Approvals"
 * to the menu or something they did not mean to write. The screen *is* holding
 * the document, so it puts the label back beside the key.
 *
 * Deactivations are the exception, and unavoidably so: a key is deactivated
 * because the manifest stopped declaring it, so the document has nothing to say
 * about it. Those rows show the bare key, which is what the operator has to
 * recognise — and the section says plainly that nothing is deleted, because a
 * red-looking list of retirements is the one part of this screen that would
 * otherwise stop an upload that was entirely correct.
 *
 * ## Grouping follows the model, not the wire
 *
 * The response groups mappings by nav node; this groups everything by *what it
 * is* — the application row, permissions, navigation, gates — because those are
 * the four things an operator holds separate opinions about. A nav node gaining
 * a gate belongs next to the other gate changes, not next to the node's own
 * relabelling, even though both name the same key.
 */

import type {
  ManifestDiff,
  ManifestMappingChange,
  NavNodeKind,
} from '@plantops/contracts';
import { spacing } from '@plantops/ui';
import { Card, Empty, Space, Tag, Typography } from 'antd';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

import { diffTotals, type ManifestIndex } from '../../lib/manifest-upload';

const code: CSSProperties = { fontFamily: 'var(--ant-font-family-code)' };

/** How each kind of change is coloured, everywhere on this screen. */
const TONE = {
  created: 'green',
  updated: 'blue',
  deactivated: 'default',
  mapped: 'geekblue',
  unmapped: 'orange',
} as const;

export interface ManifestDiffViewProps {
  diff: ManifestDiff;
  /** The document the diff was computed from — for labels beside the keys. */
  index: ManifestIndex;
  /**
   * `false` when applying this manifest would change nothing at all.
   *
   * Passed rather than re-derived: it is the server's own answer, and the
   * "re-uploading an identical manifest previews no changes" criterion is about
   * what the server said, not about what the screen concluded.
   */
  changed: boolean;
}

export function ManifestDiffView({
  diff,
  index,
  changed,
}: ManifestDiffViewProps): ReactElement {
  if (!changed) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Space direction="vertical" size={4}>
            <Typography.Text strong>No changes</Typography.Text>
            <Typography.Text type="secondary">
              The catalog already matches this manifest exactly. Uploading it
              would write no rows and no audit record.
            </Typography.Text>
          </Space>
        }
      />
    );
  }

  const totals = diffTotals(diff);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space size={[8, 8]} wrap>
        <Count tone={TONE.created} count={totals.created} label="to create" />
        <Count tone={TONE.updated} count={totals.updated} label="to update" />
        <Count
          tone={TONE.deactivated}
          count={totals.deactivated}
          label="to deactivate"
        />
        <Count tone={TONE.mapped} count={totals.mapped} label="gate added" />
        <Count tone={TONE.unmapped} count={totals.unmapped} label="gate removed" />
      </Space>

      {diff.application.changed.length > 0 && (
        <Section title="Application">
          <Row
            tone={TONE.updated}
            action="Update"
            name={diff.application.key}
            detail={`${diff.application.changed.join(', ')} would change`}
          />
        </Section>
      )}

      {(diff.permissions.created.length > 0 ||
        diff.permissions.updated.length > 0 ||
        diff.permissions.deactivated.length > 0) && (
        <Section
          title="Permissions"
          note="A permission key is permanent: roles, menu gates and audit records all address permissions by it."
        >
          {diff.permissions.created.map((key) => (
            <Row
              key={key}
              tone={TONE.created}
              action="Create"
              name={key}
              detail={index.permissions.get(key)?.name}
            />
          ))}
          {diff.permissions.updated.map((key) => (
            <Row
              key={key}
              tone={TONE.updated}
              action="Update"
              name={key}
              detail={index.permissions.get(key)?.name}
            />
          ))}
          {diff.permissions.deactivated.map((key) => (
            <Row
              key={key}
              tone={TONE.deactivated}
              action="Deactivate"
              name={key}
              detail="No longer declared by this manifest"
            />
          ))}
        </Section>
      )}

      {(diff.nav.created.length > 0 ||
        diff.nav.updated.length > 0 ||
        diff.nav.deactivated.length > 0) && (
        <Section title="Navigation">
          {diff.nav.created.map((key) => (
            <Row
              key={key}
              tone={TONE.created}
              action="Create"
              name={key}
              detail={navDetail(index, key)}
            />
          ))}
          {diff.nav.updated.map((key) => (
            <Row
              key={key}
              tone={TONE.updated}
              action="Update"
              name={key}
              detail={navDetail(index, key)}
            />
          ))}
          {diff.nav.deactivated.map((key) => (
            <Row
              key={key}
              tone={TONE.deactivated}
              action="Deactivate"
              name={key}
              detail="No longer declared by this manifest"
            />
          ))}
        </Section>
      )}

      {(diff.menu_permissions.mapped.length > 0 ||
        diff.menu_permissions.unmapped.length > 0) && (
        <Section
          title="Menu permissions"
          note="Which permissions make a menu visible. A leaf mapped to nothing is hidden from everyone unless it opted in with isPublic (Doc 05 §3)."
        >
          {diff.menu_permissions.mapped.map((change) => (
            <MappingRow
              key={`map-${change.nav_key}`}
              tone={TONE.mapped}
              action="Gate on"
              change={change}
              index={index}
            />
          ))}
          {diff.menu_permissions.unmapped.map((change) => (
            <MappingRow
              key={`unmap-${change.nav_key}`}
              tone={TONE.unmapped}
              action="Ungate from"
              change={change}
              index={index}
            />
          ))}
        </Section>
      )}

      {(diff.permissions.deactivated.length > 0 || diff.nav.deactivated.length > 0) && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Nothing is deleted. A key the manifest stops declaring is deactivated
          (Doc 02 §7): the row, its uuid, and every role mapping and menu gate
          pointing at it are kept, so declaring the key again in a later upload
          restores it exactly as it was.
        </Typography.Text>
      )}
    </Space>
  );
}

// ── the pieces ───────────────────────────────────────────────────────────────

function Count({
  tone,
  count,
  label,
}: {
  tone: string;
  count: number;
  label: string;
}): ReactElement | null {
  // Nothing rather than a zero: five tags of which three read "0" is a summary
  // the eye has to subtract before it can read.
  if (count === 0) return null;
  return (
    <Tag color={tone} style={{ marginInlineEnd: 0 }}>
      {count} {label}
    </Tag>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Card size="small" title={title} styles={{ body: { paddingBlock: spacing.sm } }}>
      {note !== undefined && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Paragraph>
      )}
      <Space direction="vertical" size={spacing.xs} style={{ width: '100%' }}>
        {children}
      </Space>
    </Card>
  );
}

function Row({
  tone,
  action,
  name,
  detail,
}: {
  tone: string;
  action: string;
  name: string;
  detail?: ReactNode;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: spacing.sm,
        flexWrap: 'wrap',
      }}
    >
      <Tag color={tone} style={{ marginInlineEnd: 0, minWidth: 92, textAlign: 'center' }}>
        {action}
      </Tag>
      <Typography.Text style={code}>{name}</Typography.Text>
      {detail !== undefined && detail !== '' && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detail}
        </Typography.Text>
      )}
    </div>
  );
}

function MappingRow({
  tone,
  action,
  change,
  index,
}: {
  tone: string;
  action: string;
  change: ManifestMappingChange;
  index: ManifestIndex;
}): ReactElement {
  const label = index.nav.get(change.nav_key)?.label;
  return (
    <Row
      tone={tone}
      action={action}
      name={change.nav_key}
      detail={
        <>
          {label !== undefined && <>“{label}” — </>}
          <span style={code}>{change.permission_keys.join(', ')}</span>
        </>
      }
    />
  );
}

/** A nav node's label, route and kind, as far as the document declares them. */
function navDetail(index: ManifestIndex, key: string): string | undefined {
  const node = index.nav.get(key);
  if (node === undefined) return undefined;

  const parts = [`“${node.label}”`, KIND_LABEL[node.kind] ?? node.kind];
  if (node.route !== undefined) parts.push(node.route);
  return parts.join(' · ');
}

const KIND_LABEL: Readonly<Record<NavNodeKind | string, string>> = {
  module: 'module',
  menu: 'menu',
  sub_menu: 'sub-menu',
};
