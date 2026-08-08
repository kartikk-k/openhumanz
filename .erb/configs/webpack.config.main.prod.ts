/**
 * Webpack config for production electron main process
 */

import path from 'path';
import webpack from 'webpack';
import { merge } from 'webpack-merge';
import TerserPlugin from 'terser-webpack-plugin';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import baseConfig from './webpack.config.base';
import webpackPaths from './webpack.paths';
import checkNodeEnv from '../scripts/check-node-env';
import deleteSourceMaps from '../scripts/delete-source-maps';
import createShimConfig from './webpack.config.shim';
import CopyFilesPlugin from './copy-files-plugin';
import { applescriptCopyFiles } from '../../src/main/modules/macos/scripts/copy-spec';

checkNodeEnv('production');
deleteSourceMaps();

const configuration: webpack.Configuration = {
  devtool: 'source-map',

  mode: 'production',

  target: 'electron-main',

  entry: {
    main: path.join(webpackPaths.srcMainPath, 'main.ts'),
    preload: path.join(webpackPaths.srcMainPath, 'preload.ts'),
  },

  output: {
    path: webpackPaths.distMainPath,
    filename: '[name].js',
    library: {
      type: 'umd',
    },
  },

  optimization: {
    minimizer: [
      new TerserPlugin({
        parallel: true,
      }),
    ],
  },

  plugins: [
    new BundleAnalyzerPlugin({
      analyzerMode: process.env.ANALYZE === 'true' ? 'server' : 'disabled',
      analyzerPort: 8888,
    }),

    /**
     * Create global constants which can be configured at compile time.
     *
     * Useful for allowing different behaviour between development builds and
     * release builds
     *
     * NODE_ENV should be production so that modules do not perform certain
     * development checks
     */
    new webpack.EnvironmentPlugin({
      NODE_ENV: 'production',
      DEBUG_PROD: false,
      START_MINIMIZED: false,
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
  createShimConfig('production'),
];
