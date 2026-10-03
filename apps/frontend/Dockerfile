# SP1: a placeholder page plus the /ws proxy. SP2 replaces /srv with the built web client.
FROM caddy:2-alpine
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY apps/frontend/public /srv
EXPOSE 80
