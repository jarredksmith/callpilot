// Copies the web app (one folder up) into www/ so Capacitor can bundle it inside the iPhone app.
// The web app stays the single source of truth: edit ../index.html and ../app.js, never www/.
// sw.js is left out on purpose: the native app has no service worker (notifications are native).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', 'www');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png']) cpSync(join(root, f), join(out, f));
console.log('Copied the web app into', out);
