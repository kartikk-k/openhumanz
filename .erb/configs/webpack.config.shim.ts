/**
 * The MCP shim bundle.
 *
 * The agent CLI spawns `shim.js` as an MCP stdio server, and we spawn it
 * through Electron in Node mode (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`)
 * because end users have no `node`. That means it must be a **standalone
 * CommonJS file**, not part of the main bundle and not UMD — hence its own
 * configuration rather than another entry on the main one.
 *
 * It lands next to the main bundle (`.erb/dll/shim.js` in dev,
 * `dist/main/shim.js` when packaged), so the spawn path is always
 * `path.join(__dirname, 'shim.js')`.
 */
import path from 'path';
import webpack from 'webpack';
import { merge } from 'webpack-merge';
import baseConfig from './webpack.config.base';
import webpackPaths from './webpack.paths';

export default function createShimConfig(
  mode: 'development' | 'production',
): webpack.Configuration {
  const isDevelopment = mode === 'development';

  return merge(baseConfig, {
    devtool: isDevelopment ? 'inline-source-map' : 'source-map',

    mode,

    // node, not electron-main: the shim runs under ELECTRON_RUN_AS_NODE and
    // must never reach for electron's own module.
    target: 'node',

    entry: {
      shim: path.join(webpackPaths.srcShimPath, 'index.ts'),
    },

    output: {
      path: isDevelopment ? webpackPaths.dllPath : webpackPaths.distMainPath,
      filename: '[name].js',
      library: {
        type: 'commonjs2',
      },
    },

    optimization: {
      // Readable stack traces matter more here than 40 KB.
      minimize: false,
    },

    plugins: [
      new webpack.EnvironmentPlugin({
        NODE_ENV: isDevelopment ? 'development' : 'production',
      }),
    ],

    node: {
      __dirname: false,
      __filename: false,
    },
  });
}
