#!/bin/zsh
# Deploy the Worker and (re)set the login password from .password.
set -e
cd "$(dirname "$0")"
npx -y wrangler@4 deploy
tr -d '\n' < .password | npx -y wrangler@4 secret put SITE_PASSWORD
echo "Check: curl -s -o /dev/null -w '%{http_code}' "$(python3 -c 'import json;print(json.load(open("config.json"))["site_url"])')"  (expect 401)"
