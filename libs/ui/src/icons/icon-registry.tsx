'use client';

/**
 * `icon` keys from the registry → the icon set this design language uses
 * (Doc 05 §7).
 *
 * Doc 05 is explicit that `nav_node.icon` is "a string key the frontend maps to
 * its icon set", and Doc 02 is explicit that the catalog is data written by
 * platform admins at runtime. Both together mean this map is the *only* place
 * the two vocabularies meet, and that it will always be incomplete: an admin
 * can type `"forklift"` into a manifest tonight and no amount of care here
 * anticipates it. So an unknown key is a normal, non-fatal outcome that falls
 * back to a neutral glyph — never a crash, and never a blank space that makes
 * the menu row jump out of alignment with its neighbours.
 *
 * The keys are deliberately generic nouns (`users`, `key`, `sitemap`) rather
 * than antd component names. A manifest that said `TeamOutlined` would pin the
 * *database* to this icon library, and swapping icon sets would then mean a
 * migration rather than an edit to this file.
 *
 * Adding a key: add the row, and mention it in the application's manifest
 * documentation. Gatepass and visitor management will add their own domain
 * nouns here (`gate`, `pass`, `vehicle`, `visitor`); the block below is
 * pre-seeded with them so those manifests can be written before their consoles
 * exist.
 */

import {
  ApartmentOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BankOutlined,
  BarChartOutlined,
  BellOutlined,
  CarOutlined,
  ClusterOutlined,
  ContainerOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOutlined,
  GlobalOutlined,
  GoldOutlined,
  HomeOutlined,
  IdcardOutlined,
  InboxOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  PartitionOutlined,
  ProfileOutlined,
  SafetyCertificateOutlined,
  SafetyOutlined,
  ScheduleOutlined,
  SearchOutlined,
  SettingOutlined,
  ShopOutlined,
  SolutionOutlined,
  TagOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import * as React from 'react';

type IconComponent = React.ComponentType<{ className?: string }>;

/**
 * The registry. Keys are the strings that appear in `nav_node.icon`.
 *
 * The first block is what `deploy/manifests/iam.manifest.json` uses today; the rest is the
 * shared vocabulary later applications draw on.
 */
const ICONS: Readonly<Record<string, IconComponent>> = Object.freeze({
  // ── Used by the IAM's own manifest ───────────────────────────────────────
  building: BankOutlined,
  grid: AppstoreOutlined,
  briefcase: ShopOutlined,
  key: KeyOutlined,
  scroll: AuditOutlined,
  shield: SafetyOutlined,
  sitemap: ApartmentOutlined,
  badge: IdcardOutlined,
  users: TeamOutlined,
  link: LinkOutlined,

  // ── General vocabulary ───────────────────────────────────────────────────
  home: HomeOutlined,
  dashboard: DashboardOutlined,
  user: UserOutlined,
  settings: SettingOutlined,
  search: SearchOutlined,
  bell: BellOutlined,
  file: FileTextOutlined,
  folder: FolderOutlined,
  tag: TagOutlined,
  chart: BarChartOutlined,
  database: DatabaseOutlined,
  globe: GlobalOutlined,
  lock: LockOutlined,
  warning: WarningOutlined,
  tool: ToolOutlined,
  bolt: ThunderboltOutlined,
  cluster: ClusterOutlined,
  partition: PartitionOutlined,
  certificate: SafetyCertificateOutlined,
  profile: ProfileOutlined,

  // ── Reserved for the operational modules (Doc 00 §9) ─────────────────────
  gate: GoldOutlined,
  pass: SolutionOutlined,
  vehicle: CarOutlined,
  visitor: IdcardOutlined,
  schedule: ScheduleOutlined,
  inbox: InboxOutlined,
  container: ContainerOutlined,
});

/** The glyph an unrecognised key renders as. */
const FALLBACK_ICON: IconComponent = AppstoreOutlined;

/** True when the key has a mapping — for a catalog editor's preview. */
export function isKnownIconKey(key: string): boolean {
  return key in ICONS;
}

/** Every key this frontend understands, sorted — for an icon picker. */
export function knownIconKeys(): string[] {
  return Object.keys(ICONS).sort();
}

/** The component for a key, or the fallback. Prefer {@link NavIcon} in JSX. */
export function iconForKey(key: string | null | undefined): IconComponent {
  if (key === null || key === undefined) return FALLBACK_ICON;
  return ICONS[key] ?? FALLBACK_ICON;
}

export interface NavIconProps {
  /** The `icon` string from a `NavNodeDTO`. `null`/absent is expected. */
  iconKey?: string | null;
  className?: string;
}

/**
 * Renders a registry icon key.
 *
 * Always renders something. A menu whose rows are sometimes 14px shorter
 * because one node's icon key was misspelt is worse than one that shows a
 * neutral glyph.
 */
export function NavIcon({ iconKey, className }: NavIconProps): React.ReactElement {
  const Icon = iconForKey(iconKey);
  return <Icon className={className} />;
}
