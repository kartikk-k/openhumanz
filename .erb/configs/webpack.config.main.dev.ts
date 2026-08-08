/**
 * Webpack config for development electron main process
 */

import path from 'path';
import webpack from 'webpack';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import { merge } from 'webpack-merge';
import checkNodeEnv from '../scripts/check-node-env';
import baseConfig from './webpack.config.base';
import webpackPaths from './webpack.paths';
import createShimConfig from './webpack.config.shim';
import CopyFilesPlugin from './copy-files-plugin';
import { applescriptCopyFiles } from '../../src/main/modules/macos/scripts/copy-spec';

// When an ESLint server is running, we can't set the NODE_ENV so we'll check if it's
// at the dev webpack config is not accidentally run in a production environment
if (process.env.NODE_ENV === 'production') {
  checkNodeEnv('development');
}

const configuration: webpack.Configuration = {
  devtool: 'inline-source-map',

  mode: 'development',

  target: 'electron-main',

  entry: {
    main: path.join(webpackPaths.srcMainPath, 'main.ts'),
    preload: path.join(webpackPaths.srcMainPath, 'preload.ts'),
  },

  output: {
    path: webpackPaths.dllPath,
    filename: '[name].bundle.dev.js',
    library: {
      type: 'umd',
    },
  },

  plugins: [
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE === 'true' ? 'server' : 'disabled',
      analyzerPort: 8888,
    }),

    new webpack.DefinePlugin({
      'process.type': '"browser"',
    }),

    // sql.js is loaded at runtime, not bundled: webpack breaks emscripten's
    // glue. Both files must sit next to the bundle. See infra/db.ts.
    // sql.js, plus the macOS module's AppleScript assets: osascript is a
    // separate process and cannot read out of app.asar, so the module reads
    // these through Node and rewrites them under the workspace at startup.
    new CopyFilesPlugin([
      { from: require.resolve('sql.js/dist/sql-wasm.js') },
      { from: require.resolve('sql.js/dist/sql-wasm.wasm') },
      ...applescriptCopyFiles(),
    ]),
  ],

  /**
   * Disables webpack processing of __dirname and __filename.
   * If you run the bundle in node.js it falls back to these values of node.js.
   * https://github.com/webpack/webpack/issues/2010
   */
  node: {
    __dirname: false,
    __filename: false,
  },
};

// An array: the main/preload bundle and the standalone CommonJS shim bundle
// are built together but cannot share an output.library type.
export default [
  merge(baseConfig, configuration),
  createShimConfig('development'),
];
