//@ts-check

const { join } = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root — a lockfile exists in an ancestor directory and
  // Next.js would otherwise mis-infer the monorepo root.
  turbopack: {
    root: join(__dirname, '../..'),
  },
};

module.exports = nextConfig;
