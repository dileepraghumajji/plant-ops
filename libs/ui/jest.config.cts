module.exports = {
  displayName: '@plantops/ui',
  preset: '../../jest.preset.js',
  // Every component here renders in a browser; the pure helpers do not care.
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  transform: {
    '^(?!.*\\.(js|jsx|ts|tsx|css|json)$)': '@nx/react/plugins/jest',
    '^.+\\.[tj]sx?$': ['babel-jest', { presets: ['@nx/react/babel'] }],
  },
  // antd 6 and its `@rc-component/*` parts ship ESM even in their `lib`
  // (CommonJS) builds — `@ant-design/icons/lib/colorUtils.js` opens with a bare
  // `import`. Jest's default of skipping node_modules therefore hands raw ESM to
  // a CommonJS runtime, which fails with "Cannot use import statement outside a
  // module" from a file no spec mentions. Transforming these packages is the
  // supported answer; narrowing the list to them keeps the other ~1800
  // dependencies untransformed and the suite fast.
  transformIgnorePatterns: [
    '/node_modules/(?!(?:@ant-design|antd|@rc-component|rc-[a-z-]+)/)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: 'test-output/jest/coverage',
};
