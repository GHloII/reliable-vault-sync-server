# Reliable Vault Sync Server

Self-hosted synchronization server for the [Reliable Vault Sync Obsidian plugin](https://github.com/GHloII/reliable-vault-sync). It stores every accepted vault revision in a Git repository and performs server-side three-way merges.

> [!WARNING]
> This is an early release. Keep independent backups. Vault contents are stored unencrypted on the server. End-to-end encryption is not implemented yet.

## Requirements

- A Linux VPS with a public IPv4 or IPv6 address.
- A DNS name whose `A` or `AAAA` record points to the VPS.
- Docker Engine with the Docker Compose plugin.
- TCP ports `80` and `443` reachable from the internet.

## Install with Docker Compose

Clone the repository on the VPS:

```bash
git clone https://github.com/GHloII/reliable-vault-sync-server.git
cd reliable-vault-sync-server
cp .env.example .env
```

Generate a token:

```bash
openssl rand -hex 32
```

Edit `.env` and set both values:

```dotenv
SYNC_DOMAIN=sync.example.com
SYNC_TOKEN=paste-the-generated-token-here
```

Start the server:

```bash
docker compose up -d --build
docker compose ps
curl https://sync.example.com/health
```

The health check should return JSON containing:

```json
{"status":"ok","protocolVersion":1,"incrementalProtocolVersion":2}
```

Caddy obtains and renews the HTTPS certificate automatically. The sync API is not exposed over plain HTTP outside the private Compose network.

## Configure the Obsidian plugin

Open **Settings → Reliable Vault Sync** on every device and enter:

- **Server URL**: `https://sync.example.com`
- **Vault ID**: the same identifier on all devices, for example `vault3`
- **Access token**: the value of `SYNC_TOKEN`
- **Device ID**: a different stable name on each device, for example `windows`, `macbook`, and `iphone`

For the first production device, use the device that contains the confirmed current copy of the vault. Back up every existing vault before connecting additional devices.

## Existing reverse proxy

The included Compose file starts Caddy and owns ports `80` and `443`. If the VPS already has Caddy, Nginx, Traefik, or another reverse proxy, do not start a second proxy on the same ports. Expose the `vault-sync` service only to the existing proxy and forward HTTPS traffic to port `8787` inside a private Docker network or to `127.0.0.1:8787`.

Example Caddy site block when the existing proxy shares a Docker network with this service:

```caddyfile
sync.example.com {
    reverse_proxy vault-sync:8787
}
```

## Data and backups

Vault data is stored in the Docker volume `reliable-vault-sync-data` as bare Git repositories. It survives container replacement and upgrades.

Create a backup while the sync service is stopped:

```bash
mkdir -p backups
docker compose stop vault-sync
docker run --rm \
  -v reliable-vault-sync-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine:3.20 \
  sh -c 'tar czf /backup/reliable-vault-sync-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .'
docker compose start vault-sync
```

Copy the resulting archive off the VPS. Test restoration on a separate server before relying on the backup.

## Operations

View status and logs:

```bash
docker compose ps
docker compose logs --tail=200 vault-sync
docker compose logs --tail=200 caddy
```

Update the server:

```bash
git pull --ff-only
docker compose up -d --build
```

Stop the stack without deleting data:

```bash
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete all server-side vault history.

## Security notes

- Use a random token of at least 32 bytes and never commit `.env`.
- Keep ports other than `80` and `443` closed to the public internet.
- Keep Docker and the base operating system updated.
- The access token protects the API but does not encrypt stored vault contents.
- Use independent encrypted backups for important vaults.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SYNC_TOKEN` | Yes | — | Bearer token shared with the plugin; minimum 16 characters. |
| `SYNC_DOMAIN` | For included Caddy | — | Public DNS name used for automatic HTTPS. |
| `HOST` | No | `0.0.0.0` | Server listen address inside the container. |
| `PORT` | No | `8787` | Server listen port inside the container. |
| `DATA_DIR` | No | `/data` | Directory containing bare Git repositories. |

## License

[MIT](LICENSE)
