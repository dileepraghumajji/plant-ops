'use client';

/**
 * Choosing a node of the org tree, and saying which kind a node is.
 *
 * Both live in `@plantops/ui` because both are needed twice, by screens that
 * must not disagree: Session 31's editor builds the structure and Session 35's
 * access screen grants against it. Doc 09 §3.4 is explicit that the scope picker
 * on the grant screen "shows the tree", so that the admin sees exactly where
 * they are granting — a flat select of node names would hide the one thing that
 * decides how far a grant reaches.
 *
 * Neither component fetches anything. They take the tree and a callback, which
 * is what keeps `scope:ui` free of the IAM client (root `eslint.config.mjs`).
 */

import type { ScopeNodeDTO, ScopeNodeKind } from '@plantops/contracts';
import { Tag, TreeSelect } from 'antd';
import * as React from 'react';

import { SCOPE_KIND_LABEL, scopeTreeData } from './scope-tree';

/**
 * The four kinds, told apart at a glance (Doc 09 §3.1: "kinds rendered
 * distinctly").
 *
 * Colour carries the nesting rather than the meaning — the sequence runs from
 * the widest scope to the narrowest, so a tree reads as a gradient inward and an
 * out-of-place kind is visible without reading the label. Nothing enforces that
 * nesting (Doc 01 §3.5 pins no kind to a depth), which is exactly why seeing it
 * is useful.
 */
const KIND_COLOR: Readonly<Record<ScopeNodeKind, string>> = {
  group: 'purple',
  plant: 'blue',
  department: 'cyan',
  gate: 'green',
};

export interface ScopeKindTagProps {
  kind: ScopeNodeKind;
}

export function ScopeKindTag({ kind }: ScopeKindTagProps): React.ReactElement {
  return (
    <Tag color={KIND_COLOR[kind]} style={{ marginInlineEnd: 0 }}>
      {SCOPE_KIND_LABEL[kind]}
    </Tag>
  );
}

export interface ScopeTreeSelectProps {
  /** Roots of the caller's tree, as `GET /iam/scopes` returns them. */
  tree: readonly ScopeNodeDTO[];
  /** The chosen node id, or `null` for nothing chosen. */
  value: string | null;
  onChange: (id: string | null) => void;
  /**
   * Nodes the operator may not choose. They stay in the tree, greyed out and
   * expandable: the node they *can* choose is often beneath one they cannot,
   * and hiding a branch would make the tree lie about the organisation.
   */
  isDisabled?: (node: ScopeNodeDTO) => boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered when the tenant has no tree at all. */
  notFoundContent?: React.ReactNode;
  allowClear?: boolean;
  style?: React.CSSProperties;
}

/**
 * A tree picker over the org structure.
 *
 * `treeDefaultExpandAll` because an org tree is tens of nodes and a picker that
 * opens collapsed makes the operator hunt for a plant they can already name.
 * `treeNodeFilterProp="title"` so typing filters by the display name, which is
 * the only part of a node a person knows — the `path` is id-derived labels
 * (Doc 01 §3.5) and searching it would match nothing anyone typed.
 */
export function ScopeTreeSelect({
  tree,
  value,
  onChange,
  isDisabled,
  placeholder = 'Choose where this applies',
  disabled = false,
  notFoundContent,
  allowClear = true,
  style,
}: ScopeTreeSelectProps): React.ReactElement {
  const treeData = React.useMemo(
    () => scopeTreeData(tree, { isDisabled }),
    [tree, isDisabled],
  );

  return (
    <TreeSelect
      value={value ?? undefined}
      onChange={(next: string | undefined) => onChange(next ?? null)}
      treeData={treeData}
      disabled={disabled}
      allowClear={allowClear}
      showSearch
      treeNodeFilterProp="title"
      treeDefaultExpandAll
      placeholder={placeholder}
      notFoundContent={notFoundContent}
      style={{ width: '100%', ...style }}
    />
  );
}
