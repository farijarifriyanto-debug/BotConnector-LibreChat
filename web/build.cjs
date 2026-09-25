const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'assets', 'botconnector');
const output = path.join(root, 'dist', 'web');
const distRoot = path.join(root, 'dist');

async function removeGenerated(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

async function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await fsp.rename(from, to); return; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function main() {
  const staging = path.join(distRoot, `.web-build-${process.pid}-${Date.now()}`);
  const backup = path.join(distRoot, `.web-previous-${process.pid}-${Date.now()}`);
  await removeGenerated(staging);
  await fsp.mkdir(staging, { recursive: true });
  for (const file of ['index.html', 'app.css', 'app.js']) {
    let content = await fsp.readFile(path.join(source, file), 'utf8');
    if (file === 'index.html') {
      content = content.replace('<link rel="stylesheet" href="/app.css">', '<link rel="stylesheet" href="./app.css"><link rel="manifest" href="./manifest.webmanifest">')
        .replace('<script src="/app.js" defer></script>', '<script src="./config.js" defer></script>\n  <script src="./app.js" defer></script>');
    }
    await fsp.writeFile(path.join(staging, file), content);
  }
  await fsp.writeFile(path.join(staging, 'manifest.webmanifest'), JSON.stringify({
    name: 'BotConnector AI', short_name: 'BotConnector', start_url: './', scope: './', display: 'standalone',
    background_color: '#f5f6f2', theme_color: '#f5f6f2', description: 'Local-first AI workspace for cloud and local models.',
    icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }, null, 2));
  const localCoreBase = process.env.BOTCONNECTOR_LOCAL_CORE_BASE || 'http://127.0.0.1:18764';
  await fsp.writeFile(path.join(staging, 'config.js'), `window.BOTCONNECTOR_CONFIG={mode:"web",basePath:"./",localCoreBase:${JSON.stringify(localCoreBase)}};`);
  await fsp.writeFile(path.join(staging, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="#18332d"/><path d="M43 58a18 18 0 0 1 18-18h70a18 18 0 0 1 18 18v38a18 18 0 0 1-18 18h-32l-31 27v-27h-7a18 18 0 0 1-18-18V58Z" fill="none" stroke="#f5f6f2" stroke-width="11" stroke-linejoin="round"/><circle cx="143" cy="143" r="25" fill="#b9f47d"/><path d="M143 130v26M130 143h26" stroke="#18332d" stroke-width="8" stroke-linecap="round"/></svg>');
  await fsp.writeFile(path.join(staging, 'sw.js'), "const CACHE='botconnector-web-shell-v6'; self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(['./','./index.html','./config.js','./app.css','./app.js','./manifest.webmanifest','./icon.svg'])))); self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))); self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||new URL(event.request.url).pathname.includes('/v1/')||new URL(event.request.url).pathname.includes('/api/'))return; event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(response=>{const copy=response.clone(); caches.open(CACHE).then(cache=>cache.put(event.request,copy)); return response;})));});");
  await fsp.writeFile(path.join(staging, 'security-headers.json'), JSON.stringify({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:18764 http://localhost:18764; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  }, null, 2));
  await removeGenerated(backup);
  try {
    if (fs.existsSync(output)) await renameWithRetry(output, backup);
    await renameWithRetry(staging, output);
    await removeGenerated(backup);
  } catch (error) {
    await removeGenerated(staging).catch(() => {});
    throw new Error(`Web build staging berhasil tetapi promosi gagal (${error.code || 'ERROR'}): ${error.message}`);
  }
  console.log(`Web build ready: ${output}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { output, main };
