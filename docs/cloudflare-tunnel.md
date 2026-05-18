# Cloudflare Tunnel setup (§13 step 13)

ChannelHelm runs local-first, but two surfaces need the public internet:

1. **Inbound webhooks** — Zernio needs to POST `post.published` events at
   `POST /api/webhooks/zernio`, and (optionally) DojoClaw can POST
   `article.completed` events at `POST /api/webhooks/dojoclaw`.
2. **Media for Zernio** — Zernio downloads `mediaUrls` when posting a
   rendered clip or thumbnail. The clip files live under `$MEDIA_ROOT`
   on the M4 Max; they need to be reachable by Zernio over HTTPS.

Both are solved with a single Cloudflare Tunnel running on the M4 Max.
This file is the operator's runbook — Claude does not (and should not)
deploy this for you.

## One-time setup on the M4 Max

```bash
# Install cloudflared if you haven't already
brew install cloudflared

# Authenticate against your Cloudflare account
cloudflared tunnel login

# Create a named tunnel — pick whatever name you like
cloudflared tunnel create channelhelm

# Note the printed tunnel UUID; you'll wire it into the config below
```

## Tunnel config

`~/.cloudflared/config.yml` on the M4 Max:

```yaml
tunnel: <UUID printed by `tunnel create`>
credentials-file: /Users/thorstenmeyer/.cloudflared/<UUID>.json

ingress:
  # Next.js webhook routes
  - hostname: channelhelm.<your-zone>.com
    path: /api/webhooks/*
    service: http://localhost:3000

  # nginx serving $MEDIA_ROOT as a static directory
  - hostname: channelhelm.<your-zone>.com
    path: /media/*
    service: http://localhost:8088

  # Refuse anything else — explicitly catch-all 404
  - service: http_status:404
```

The `/media/*` path needs a small static-file server (any will do — nginx,
caddy, even `python -m http.server`). The contract assumes nginx pointed at
`$MEDIA_ROOT`.

## DNS routing

```bash
cloudflared tunnel route dns channelhelm channelhelm.<your-zone>.com
```

## Launching the tunnel under launchd

Generate the launchd plist:

```bash
sudo cloudflared service install
```

This installs to `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`
and starts the tunnel on boot. Verify with `launchctl list | grep cloudflare`.

## Wire it into ChannelHelm

In `.env` on the M4 Max:

```
CLOUDFLARE_TUNNEL_HOSTNAME=https://channelhelm.<your-zone>.com
```

The `dispatch` worker reads this when it builds the `callback_url` for
Zernio and DojoClaw — see `workers/kinds/dispatch.ts`. If unset, dispatch
falls back to `http://localhost:3000`, which only works for DojoClaw on the
same LAN and is useless for Zernio.

## Acceptance check (§13.13)

After the tunnel is live:

```bash
curl -sS -X POST https://channelhelm.<your-zone>.com/api/webhooks/zernio \
  -H 'content-type: application/json' \
  -d '{"_id":"manual_smoke_1","event":"post.published","postId":"zer_test"}'
```

Should return `{"accepted": true, "sourceEventId": "manual_smoke_1"}`. A
second identical request should return `{"accepted": true, "duplicate": true}`.

Then verify the row landed in Postgres:

```sql
SELECT source, source_event_id, event_type, processed
  FROM webhook_events
 WHERE source = 'zernio'
 ORDER BY received_at DESC LIMIT 5;
```
