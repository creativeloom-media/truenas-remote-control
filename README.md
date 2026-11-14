# TrueNAS Remote Control

A home-screen app (PWA) to power a TrueNAS server on, off or restart it, and schedule those actions from your phone, without logging into the web portal.

## How it works
- **Relay** (`server.js`): a small Node service on an always-on device in your LAN. It holds the TrueNAS API key, calls `system.shutdown` / `system.reboot` over the TrueNAS WebSocket API, sends Wake-on-LAN packets for power on, and runs the schedules.
- **App** (`public/`): a PWA served by the relay. Open it on your phone and use "Add to Home Screen".

A powered-off NAS cannot receive API calls, so power on uses Wake-on-LAN. Enable it in the NAS BIOS and on its network card. The relay must stay on for schedules to run.

## Setup
1. TrueNAS: user menu (top right) > **API Keys** > **Add**, copy the key.
2. Find the NAS MAC address (**Network > Interfaces**).
3. On the relay device:
   ```
   cp .env.example .env    # set NAS_API_KEY, NAS_MAC, APP_PIN
   docker compose up -d
   ```
   Or without Docker: `npm ci && set -a && . ./.env && set +a && npm start`
4. On your phone open `http://<relay-ip>:8080`, enter the PIN, then Add to Home Screen.

Host networking is used so Wake-on-LAN broadcasts reach your LAN (Linux hosts).

## Security
- LAN only. Do not expose the relay to the internet. For remote use, put the relay behind Tailscale or WireGuard.
- All API calls need the PIN; 5 wrong attempts lock an IP out for a minute.
- Set `NAS_VERIFY_TLS=true` if the NAS has a trusted certificate.

## Tests
`npm test`
