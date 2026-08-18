//@ts-check

const { join } = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root — a lockfile exists in an ancestor directory and
  // Next.js would otherwise mis-infer the monorepo root.
  turbopack: {
    root: join(__dirname, '../..'),
  },

  // `@plantops/ui` and `@plantops/web-kit` are consumed as TypeScript source:
  // their `package.json` points `main` at `src/index.ts`, so a change to a
  // shared component shows up in `next dev` without a separate library build.
  // Next does not transpile node_modules by default, and the workspace symlink
  // puts them there — hence this list. `@plantops/contracts` and
  // `@plantops/iam-client` are absent on purpose: they publish compiled ESM to
  // `dist` and are consumed that way, which is why the dev/build targets depend
  // on `^build`.
  transpilePackages: ['@plantops/ui', '@plantops/web-kit'],

  // antd 6 is a large surface and the console imports it broadly. This keeps
  // the two icon/component packages out of the "one giant barrel import" path.
  experimental: {
    optimizePackageImports: ['antd', '@ant-design/icons'],
  },
};

module.exports = nextConfig;
