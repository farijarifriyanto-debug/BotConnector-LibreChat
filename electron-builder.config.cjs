const path = require('node:path');

const coreName = process.platform === 'win32' ? 'botconnector.exe' : 'botconnector';

module.exports = {
  appId: 'id.botconnector.workspace',
  productName: 'BotConnector',
  directories: { output: 'dist/desktop' },
  files: ['desktop/**/*', 'package.json'],
  extraResources: [
    { from: path.join('target', 'release', coreName), to: coreName },
    { from: 'LICENSE-MIT', to: path.join('licenses', 'LICENSE-MIT') },
    { from: 'LICENSE-APACHE', to: path.join('licenses', 'LICENSE-APACHE') },
    { from: 'THIRD_PARTY_NOTICES.md', to: path.join('licenses', 'THIRD_PARTY_NOTICES.md') },
  ],
  asar: true,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  win: { target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: { target: ['dmg'] },
  linux: { target: ['AppImage'] },
};
