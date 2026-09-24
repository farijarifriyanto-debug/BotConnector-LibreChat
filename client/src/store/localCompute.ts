import { atomWithLocalStorage } from '~/store/utils';

export type BotConnectorComputeTarget = 'cloud' | 'device';

const botconnectorComputeTarget = atomWithLocalStorage<BotConnectorComputeTarget>(
  'botconnectorComputeTarget',
  'cloud',
  (value) => (value === 'device' ? 'device' : 'cloud'),
);

const botconnectorLocalModelPath = atomWithLocalStorage<string>(
  'botconnectorLocalModelPath',
  '',
  (value) => (typeof value === 'string' ? value : ''),
);

export default {
  botconnectorComputeTarget,
  botconnectorLocalModelPath,
};
