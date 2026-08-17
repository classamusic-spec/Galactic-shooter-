/**
 * Shared headless-browser launcher.
 *
 * The container ships a pre-installed Chromium whose build number does not match
 * the npm `playwright` package's expectation, so `chromium.launch()` fails with
 * "Executable doesn't exist". Always go through `launchBrowser()` — it points at
 * the real binary and sets the flags needed to get WebGL2 out of a headless,
 * GPU-less machine (ANGLE over SwiftShader).
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.GF_CHROME,
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

export function chromePath() {
  for (const p of CANDIDATES) if (p && existsSync(p)) return p;
  return undefined; // fall back to whatever playwright can find
}

export const GL_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
  '--force-device-scale-factor=1',
  '--disable-features=CalculateNativeWinOcclusion',
  '--js-flags=--max-old-space-size=4096',
];

export async function launchBrowser(extra = {}) {
  const executablePath = chromePath();
  return chromium.launch({
    headless: true,
    executablePath,
    args: [...GL_ARGS, ...(extra.args ?? [])],
    ...extra,
    // executablePath must not be overridden away by a spread above.
    ...(executablePath ? { executablePath } : {}),
  });
}

/** Open a page with console/error capture already wired. */
export async function openPage(browser, { width = 1920, height = 1080 } = {}) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const t = `[${m.type()}] ${m.text()}`;
    logs.push(t);
    if (m.type() === 'error') errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
  return { page, logs, errors };
}
