/**
 * The browser APIs jsdom does not implement but Ant Design 6 assumes.
 *
 * antd's responsive grid subscribes to `matchMedia`, and several components
 * (Table's sticky header, Menu's overflow, Sider's collapse) observe their own
 * size. jsdom provides neither, and the failure mode is a `TypeError` inside a
 * component's first effect rather than anything that names the missing API — so
 * they are stubbed once here rather than rediscovered per spec file.
 *
 * The stubs are inert: nothing in this library's behaviour depends on a media
 * query matching or an element having a size, and a test that did would be
 * testing the browser rather than the component.
 */

class ResizeObserverStub {
  observe(): void {
    /* no layout in jsdom to report */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverStub,
});

Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Object.defineProperty(globalThis, 'scrollTo', {
  writable: true,
  configurable: true,
  value: () => undefined,
});
