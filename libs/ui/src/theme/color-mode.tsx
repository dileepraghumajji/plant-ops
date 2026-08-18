'use client';

/**
 * Which colour mode is showing, and how a user changes it.
 *
 * Split out of {@link PlantOpsThemeProvider} because the header's toggle needs
 * to *set* the mode from far below the provider that applies it, and a context
 * is the only way to do that without every shell prop-drilling a setter it does
 * not otherwise care about.
 *
 * ## Hydration
 *
 * The stored preference lives in `localStorage`, which the server cannot read —
 * so the first render always uses `defaultMode` and the stored value is adopted
 * in an effect. Rendering the stored mode directly would produce server HTML
 * that disagrees with the first client render, and React would discard the
 * whole tree. The visible cost is one frame in the default mode on a hard
 * reload; consumers that mind can inline a blocking script that sets the
 * preference before paint and pass it as `defaultMode`.
 */

import * as React from 'react';

import type { ColorMode } from './tokens';

/** Where the preference is kept. Shared by every PlantOps console on the host. */
export const COLOR_MODE_STORAGE_KEY = 'plantops.color-mode';

export interface ColorModeContextValue {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
}

const ColorModeContext = React.createContext<ColorModeContextValue | null>(null);

/**
 * The current colour mode.
 *
 * Throws outside a {@link PlantOpsThemeProvider} rather than defaulting to
 * light: a silent default would render a toggle that appears to work and
 * changes nothing.
 */
export function useColorMode(): ColorModeContextValue {
  const value = React.useContext(ColorModeContext);
  if (value === null) {
    throw new Error(
      'useColorMode() requires a <PlantOpsThemeProvider> above it in the tree.',
    );
  }
  return value;
}

function isColorMode(value: unknown): value is ColorMode {
  return value === 'light' || value === 'dark';
}

/** Reads the persisted preference, tolerating storage being unavailable. */
function readStoredMode(storageKey: string): ColorMode | null {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return isColorMode(stored) ? stored : null;
  } catch {
    // Private-mode Safari and locked-down enterprise policies both throw on
    // access rather than returning null. A theme preference is not worth an
    // error boundary.
    return null;
  }
}

function writeStoredMode(storageKey: string, mode: ColorMode): void {
  try {
    globalThis.localStorage?.setItem(storageKey, mode);
  } catch {
    /* see readStoredMode */
  }
}

export interface ColorModeProviderProps {
  children: React.ReactNode;
  /** What renders before the stored preference is known. Default `'light'`. */
  defaultMode?: ColorMode;
  /** Override to give an app its own preference slot. */
  storageKey?: string;
}

/** Supplies {@link useColorMode}. {@link PlantOpsThemeProvider} includes one. */
export function ColorModeProvider({
  children,
  defaultMode = 'light',
  storageKey = COLOR_MODE_STORAGE_KEY,
}: ColorModeProviderProps): React.ReactElement {
  const [mode, setModeState] = React.useState<ColorMode>(defaultMode);

  React.useEffect(() => {
    const stored = readStoredMode(storageKey);
    if (stored !== null) setModeState(stored);
  }, [storageKey]);

  const setMode = React.useCallback(
    (next: ColorMode) => {
      setModeState(next);
      writeStoredMode(storageKey, next);
    },
    [storageKey],
  );

  const value = React.useMemo<ColorModeContextValue>(
    () => ({
      mode,
      setMode,
      toggle: () => setMode(mode === 'dark' ? 'light' : 'dark'),
    }),
    [mode, setMode],
  );

  return (
    <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>
  );
}
