/**
 * The loader for `emit-openapi.ts`, and the only script in `tools/` that is not
 * plain TypeScript run under `tsx`.
 *
 * Two things force it, and both are worth stating because neither is guessable
 * from the outside.
 *
 * **`tsx` cannot run the generator at all.** It compiles with esbuild, and
 * esbuild does not implement `emitDecoratorMetadata`. That metadata is exactly
 * what the generator reads: `design:paramtypes` is how a handler's `@Body()`
 * parameter is connected to the DTO class that validates it. Under `tsx` the
 * document would build successfully and simply have no request bodies in it,
 * which is the worst of the available failure modes.
 *
 * **The workspace is mixed module systems.** `libs/*` are `"type": "module"`
 * and `apps/iam-api` is not, which webpack and Jest both paper over by
 * transpiling everything into one system. Node's own ESM loader does not, so
 * the generator runs through `@swc-node/register` in CommonJS mode — the same
 * transform Jest uses, configured here explicitly rather than through
 * `SWC_NODE_PROJECT`, which is awkward to set portably in an npm script.
 *
 *   npm run openapi
 *   npm run openapi -- --check
 */

const Module = require('node:module');

/**
 * `./errors.js` → `./errors.ts`.
 *
 * `libs/*` are ESM and therefore write the extension on every relative import,
 * as Node's ESM resolver requires. Loading them as CommonJS means asking
 * `require` for a `.js` file that was never emitted, so the extension is
 * rewritten on the way through — only for relative specifiers, and only after
 * the real resolution has already failed.
 *
 * webpack and Jest both do the equivalent through their own resolvers; this is
 * the same rule, spelled out because nothing else here has one.
 */
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  try {
    return resolveFilename.call(this, request, ...rest);
  } catch (error) {
    if (!request.startsWith('.') || !request.endsWith('.js')) throw error;
    return resolveFilename.call(this, `${request.slice(0, -3)}.ts`, ...rest);
  }
};

require('@swc-node/register/register').register({
  module: 'commonjs',
  target: 'es2022',
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  esModuleInterop: true,
});

// `Reflect.getMetadata` — the generator reads what the decorators wrote.
require('reflect-metadata');
require('./emit-openapi.ts');
