'use client';

/**
 * The one provider every PlantOps console mounts at its root.
 *
 * Three things it does, each of which is a bug if an app forgets it:
 *
 * 1. **`ConfigProvider`** applies {@link plantOpsTheme}, so the app looks like
 *    PlantOps rather than like default antd.
 * 2. **`App`** supplies the `message`/`notification`/`modal` *hooks*. antd's
 *    static `message.error(…)` renders outside the React tree and therefore
 *    outside the theme — it comes out unstyled and, in dark mode, illegible.
 *    Everything in this library and in `@plantops/web-kit` reaches feedback
 *    through `App.useApp()`, which only works with this component mounted.
 * 3. A **root surface**: `body` gets the layout background and the base text
 *    colour, which antd itself does not set.
 *
 * `ColorModeProvider` is included so that a consumer mounts one component
 * rather than remembering the order of two. An app that already has its own
 * colour-mode source can pass `mode` and skip it.
 */

import { App as AntApp, ConfigProvider } from 'antd';
import * as React from 'react';

import { ColorModeProvider, useColorMode } from './color-mode';
import { plantOpsTheme } from './theme';
import type { ColorMode } from './tokens';

export interface PlantOpsThemeProviderProps {
  children: React.ReactNode;
  /**
   * Fixes the colour mode and disables the internal preference store — for a
   * consumer whose mode comes from elsewhere (a user profile, an OS media
   * query it already watches). Omit for the normal, self-managing behaviour.
   */
  mode?: ColorMode;
  /** Initial mode before a stored preference is read. Default `'light'`. */
  defaultMode?: ColorMode;
  /** `localStorage` slot for the preference. */
  storageKey?: string;
}

export function PlantOpsThemeProvider({
  children,
  mode,
  defaultMode,
  storageKey,
}: PlantOpsThemeProviderProps): React.ReactElement {
  if (mode !== undefined) {
    return <ThemedApp mode={mode}>{children}</ThemedApp>;
  }
  return (
    <ColorModeProvider defaultMode={defaultMode} storageKey={storageKey}>
      <ThemedAppFromContext>{children}</ThemedAppFromContext>
    </ColorModeProvider>
  );
}

function ThemedAppFromContext({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { mode } = useColorMode();
  return <ThemedApp mode={mode}>{children}</ThemedApp>;
}

function ThemedApp({
  mode,
  children,
}: {
  mode: ColorMode;
  children: React.ReactNode;
}): React.ReactElement {
  const theme = React.useMemo(() => plantOpsTheme(mode), [mode]);

  return (
    <ConfigProvider theme={theme}>
      <AntApp
        // Room for the fixed header, so a toast never lands on top of the
        // navigation the user is trying to click.
        message={{ top: 72, maxCount: 3 }}
        notification={{ placement: 'topRight', top: 72 }}
        style={{ minHeight: '100%' }}
      >
        <RootSurface>{children}</RootSurface>
      </AntApp>
    </ConfigProvider>
  );
}

/**
 * Paints `body` from the active theme.
 *
 * A `<style>` element rather than a wrapper `div` because the background has to
 * reach the document element: overscroll, and any fixed-position overlay antd
 * portals into `body`, both show whatever is behind the React root.
 */
function RootSurface({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      <style>{`
        html, body { height: 100%; }
        body {
          margin: 0;
          background: var(--ant-color-bg-layout);
          color: var(--ant-color-text);
          font-family: var(--ant-font-family);
          -webkit-font-smoothing: antialiased;
        }
        *, *::before, *::after { box-sizing: border-box; }
      `}</style>
      {children}
    </>
  );
}
