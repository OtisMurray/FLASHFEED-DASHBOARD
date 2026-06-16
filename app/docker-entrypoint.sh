#!/bin/sh
set -e

# Substitute environment variables in nginx config template
# Default to http://backend:3001 if API_URL not set
API_URL="${API_URL:-http://backend:3001}"

export API_URL
envsubst '${API_URL}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

echo "⚡ Nginx configured: API_URL=${API_URL}"

exec "$@"