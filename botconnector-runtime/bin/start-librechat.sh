#!/bin/sh
set -eu
cd /home/botadmin/newbotconnector/runtime/librechat/source
export NODE_ENV=production
exec /home/botadmin/.nvm/versions/node/v24.20.0/bin/node --env-file=.env api/server/index.js
