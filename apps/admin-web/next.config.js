//@ts-check

const { join } = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root — a lockfile exists in an ancestor directory and
  // Next.js would otherwise mis-infer the monorepo root.
  turbopack: {
    root: join(__dirname, '../..'),
  },

  // A self-contained server bundle in `.next/standalone`, which is what
  // `apps/admin-web/Dockerfile` ships (roadmap Session 41, Doc 11 §5.3).
  //
  // Without it the only way to run a built console is `next start` inside a
  // full workspace install — a gigabyte of `node_modules` and a monorepo
  // checkout, in an image whose whole job is to serve a few megabytes of static
  // assets. `standalone` traces what `server.js` actually imports and copies
  // only that, so the runtime stage needs no npm install at all.
  //
  // Two consequences worth knowing before editing this file:
  //
  //   1. The trace root is the **workspace** root, inferred from the lockfile
  //      there, so the output mirrors the monorepo: `server.js` lands at
  //      `.next/standalone/apps/admin-web/server.js` with `node_modules` beside
  //      it at the top. The Dockerfile copies the whole tree and starts it from
  //      that path — see its comments.
  //   2. `.next/static` and `public/` are deliberately **not** traced (they are
  //      served, not imported), so the Dockerfile copies both in by hand. A
  //      console that boots and then 404s every stylesheet is what forgetting
  //      that looks like.
  output: 'standalone',

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
