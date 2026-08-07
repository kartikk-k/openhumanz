/**
 * Copy loose files into a bundle's output directory after emit.
 *
 * Used for `sql-wasm.wasm`: sql.js is a WASM module, and emscripten looks for
 * the `.wasm` relative to the *script* directory. For a webpack bundle that is
 * `.erb/dll/` in dev and `dist/main/` (inside `app.asar`) when packaged, so the
 * file has to be sitting next to the bundle in both. `infra/db.ts` then finds
 * it with `path.join(__dirname, 'sql-wasm.wasm')`.
 *
 * A dedicated dependency (copy-webpack-plugin) would buy nothing over this.
 */
import fs from 'fs';
import path from 'path';
import type { Compiler } from 'webpack';

export interface CopyFileSpec {
  /** Absolute source path. */
  from: string;
  /** Basename in the output directory. Defaults to the source basename. */
  to?: string;
}

export default class CopyFilesPlugin {
  private readonly files: CopyFileSpec[];

  constructor(files: CopyFileSpec[]) {
    this.files = files;
  }

  apply(compiler: Compiler): void {
    compiler.hooks.afterEmit.tapPromise('CopyFilesPlugin', async () => {
      const outputPath = compiler.options.output.path;
      if (!outputPath) return;
      await fs.promises.mkdir(outputPath, { recursive: true });
      await Promise.all(
        this.files.map(async (file) => {
          const destination = path.join(
            outputPath,
            file.to ?? path.basename(file.from),
          );
          await fs.promises.copyFile(file.from, destination);
        }),
      );
    });
  }
}
