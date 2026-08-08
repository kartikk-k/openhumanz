/**
 * The build's view of the `.applescript` assets.
 *
 * Imported by the webpack main configs, never by anything that runs. It lives
 * next to the scripts so the list cannot drift from the directory: webpack asks
 * the filesystem at build time rather than carrying a hand-maintained list in
 * two config files that someone will forget to update when they add a script.
 *
 * Destination is a subdirectory rather than the bundle root so twenty files do
 * not land next to `main.js`, and `scripts.ts` looks for exactly that name.
 */
import fs from 'fs';
import path from 'path';

/** Must match `BUNDLED_SCRIPTS_DIRNAME` in `../scripts.ts`. */
export const SCRIPTS_OUTPUT_DIRNAME = 'macos-scripts';

export interface CopySpec {
  from: string;
  to: string;
}

/** Every `.applescript` in this directory, as copy-files-plugin specs. */
export function applescriptCopyFiles(): CopySpec[] {
  const sourceDir = __dirname;
  return fs
    .readdirSync(sourceDir)
    .filter((name) => name.endsWith('.applescript'))
    .sort()
    .map((name) => ({
      from: path.join(sourceDir, name),
      to: path.posix.join(SCRIPTS_OUTPUT_DIRNAME, name),
    }));
}
