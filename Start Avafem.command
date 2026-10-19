#!/bin/zsh
set -eu

# Double-click on macOS, or run this file in Terminal. No secrets are embedded.
project_dir=${0:A:h}
cd "$project_dir"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  print 'Install Node.js 24 or newer from nodejs.org, then open this launcher again.'
  read '?Press Return to close. '
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  print 'Avafem requires Node.js 24 or newer. Update Node.js and try again.'
  read '?Press Return to close. '
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm ci
fi
npm run build
print '\nOpen http://127.0.0.1:4317 in your browser after the server starts.'
print 'Keep this Terminal window open. Press Control-C to stop Avafem.\n'
npm start
