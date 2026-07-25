import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function artifactsDir() {
  const root =
    process.env.LONGCAT2API_ARTIFACTS_DIR ||
    process.env.PLAYWRIGHT_ARTIFACTS_DIR ||
    (process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, 'debug')
      : path.join(process.cwd(), 'data', 'debug'));
  mkdirSync(root, { recursive: true });
  return root;
}

export function artifactPath(...segments) {
  return path.join(artifactsDir(), ...segments);
}
