const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

class LocalSettings {
  constructor(userData) {
    this.file = path.join(userData, 'local-models.json');
    this.data = null;
  }

  defaults() {
    return {
      modelsDir: path.join(os.homedir(), 'BotConnector AI', 'models'),
      runtimeBackend: 'auto',
    };
  }

  load() {
    if (this.data) return this.data;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.defaults(), ...saved };
    } catch {
      this.data = this.defaults();
    }
    return this.data;
  }

  get(key) { return this.load()[key]; }

  async set(key, value) {
    this.load()[key] = value;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.data;
  }
}

module.exports = { LocalSettings };
