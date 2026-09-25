const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { extractZipSecure } = require('./runtime-manager.cjs');

const execFileAsync = promisify(execFile);
const REPOS = Object.freeze({
  'llama-swap': 'mostlygeek/llama-swap',
  llmfit: 'AlexsJones/llmfit',
});
const BINARIES = Object.freeze({ 'llama-swap': 'llama-swap.exe', llmfit: 'llmfit.exe' });
const LICENSES = Object.freeze({ 'llama-swap': 'LICENSE.md', llmfit: 'LICENSE' });

function isSupportedPlatform() { return process.platform === 'win32' && process.arch === 'x64'; }

function releaseAsset(name, component) {
  if (component === 'llama-swap') return /^llama-swap_\d+_windows_amd64\.zip$/i.test(name);
  return /^llmfit-v\d+\.\d+\.\d+-x86_64-pc-windows-msvc\.zip$/i.test(name);
}

async function findBinary(root, name) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    }
  }
  return null;
}

class SidecarManager {
  constructor({ baseDir, emit }) {
    this.baseDir = baseDir;
    this.emit = emit || (() => {});
    this.children = new Map();
    this.logs = new Map();
  }

  async binary(name) { return findBinary(path.join(this.baseDir, name), BINARIES[name]); }

  async status(name) {
    const binary = await this.binary(name);
    const child = this.children.get(name);
    return { name, installed: Boolean(binary), binary, running: Boolean(child && child.exitCode === null), pid: child?.pid || null };
  }

  async allStatus() {
    return Object.fromEntries(await Promise.all(Object.keys(REPOS).map(async name => [name, await this.status(name)])));
  }

  async install(name) {
    if (!isSupportedPlatform()) throw new Error('Installer komponen otomatis saat ini tersedia untuk Windows x64.');
    if (!REPOS[name]) throw new Error('Nama komponen tidak dikenal.');
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'BotConnector-AIChat/0.2' };
    const releaseResponse = await fetch(`https://api.github.com/repos/${REPOS[name]}/releases/latest`, { headers, signal: AbortSignal.timeout(30000) });
    if (!releaseResponse.ok) throw new Error(`Tidak bisa memeriksa rilis ${name} (HTTP ${releaseResponse.status}).`);
    const release = await releaseResponse.json();
    const asset = (release.assets || []).find(item => releaseAsset(item.name, name));
    if (!asset) throw new Error(`Rilis ${release.tag_name || ''} tidak menyediakan binary Windows x64 untuk ${name}.`);

    await fsp.mkdir(this.baseDir, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(this.baseDir, `.staging-${name}-`));
    const archive = path.join(staging, asset.name);
    try {
      this.emit('sidecar:progress', { name, status: 'downloading', release: release.tag_name, totalBytes: asset.size || 0, downloadedBytes: 0 });
      const response = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'BotConnector-AIChat/0.2' }, signal: AbortSignal.timeout(20 * 60 * 1000), redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Unduhan ${name} gagal (HTTP ${response.status}).`);
      const handle = await fsp.open(archive, 'wx');
      const hash = crypto.createHash('sha256');
      let downloadedBytes = 0;
      try {
        for await (const chunk of response.body) {
          await handle.writeFile(chunk);
          hash.update(chunk);
          downloadedBytes += chunk.length;
          if (downloadedBytes % (8 * 1024 * 1024) < chunk.length) this.emit('sidecar:progress', { name, status: 'downloading', release: release.tag_name, totalBytes: asset.size || 0, downloadedBytes });
        }
      } finally { await handle.close(); }
      const expected = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
      const actual = hash.digest('hex');
      if (expected && actual !== expected) throw new Error(`Verifikasi SHA256 ${name} gagal.`);
      this.emit('sidecar:progress', { name, status: 'extracting', release: release.tag_name, totalBytes: asset.size || 0, downloadedBytes });
      const unpacked = path.join(staging, 'unpacked');
      await extractZipSecure(archive, unpacked);
      const extracted = await findBinary(unpacked, BINARIES[name]);
      if (!extracted) throw new Error(`Binary ${BINARIES[name]} tidak ditemukan di rilis.`);
      const targetDir = path.join(this.baseDir, name);
      const replacementDir = path.join(this.baseDir, `.new-${name}-${process.pid}`);
      await fsp.rm(replacementDir, { recursive: true, force: true });
      await fsp.mkdir(replacementDir, { recursive: true });
      await fsp.copyFile(extracted, path.join(replacementDir, BINARIES[name]));
      const licenseUrl = `https://raw.githubusercontent.com/${REPOS[name]}/main/${LICENSES[name]}`;
      const licenseResponse = await fetch(licenseUrl, { headers: { 'User-Agent': 'BotConnector-AIChat/0.2' }, signal: AbortSignal.timeout(30000) });
      if (!licenseResponse.ok) throw new Error(`Tidak bisa mengambil lisensi MIT ${name} (HTTP ${licenseResponse.status}).`);
      const licenseText = await licenseResponse.text();
      if (!licenseText.includes('MIT License')) throw new Error(`Berkas lisensi ${name} tidak sesuai lisensi MIT yang diharapkan.`);
      await fsp.writeFile(path.join(replacementDir, LICENSES[name]), licenseText, 'utf8');
      const oldDir = `${targetDir}.previous`;
      await fsp.rm(oldDir, { recursive: true, force: true });
      try { await fsp.rename(targetDir, oldDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fsp.rename(replacementDir, targetDir); }
      catch (error) {
        try { await fsp.rename(oldDir, targetDir); } catch { /* Keep the original install if promotion failed. */ }
        throw error;
      }
      await fsp.rm(oldDir, { recursive: true, force: true });
      const binary = await this.binary(name);
      await execFileAsync(binary, ['--version'], { windowsHide: true, timeout: 15000 }).catch(async () => {
        if (name !== 'llama-swap') throw new Error(`Binary ${name} tidak bisa dijalankan.`);
        await execFileAsync(binary, ['-version'], { windowsHide: true, timeout: 15000 });
      });
      this.emit('sidecar:progress', { name, status: 'completed', release: release.tag_name, binary });
      return { name, binary, version: release.tag_name };
    } catch (error) {
      this.emit('sidecar:progress', { name, status: 'failed', error: String(error.message || error) });
      throw error;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async installAll() {
    const installed = {};
    for (const name of Object.keys(REPOS)) installed[name] = await this.install(name);
    return installed;
  }

  stop(name) {
    const child = this.children.get(name);
    if (!child || child.exitCode !== null) return false;
    child.kill();
    this.children.delete(name);
    return true;
  }

  async start(name, args, port, pathName) {
    const binary = await this.binary(name);
    if (!binary) throw new Error(`Komponen ${name} belum dipasang.`);
    const existing = this.children.get(name);
    if (existing && existing.exitCode === null) return { pid: existing.pid, port, running: true };
    const child = spawn(binary, args, { cwd: pathName, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(name, child);
    this.logs.set(name, []);
    const addLog = (chunk) => {
      const rows = this.logs.get(name) || [];
      rows.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      this.logs.set(name, rows.slice(-100));
    };
    child.stdout.on('data', addLog);
    child.stderr.on('data', addLog);
    child.once('error', error => addLog(`ERROR: ${error.message}`));
    child.once('exit', (code, signal) => {
      addLog(`EXIT code=${code} signal=${signal}`);
      if (this.children.get(name) === child) this.children.delete(name);
    });
    return { pid: child.pid, port, running: true };
  }

  logs(name) { return (this.logs.get(name) || []).slice(-100); }
  stopAll() { for (const name of this.children.keys()) this.stop(name); }
}

module.exports = { SidecarManager, REPOS, LICENSES, isSupportedPlatform };
