# Bombay Mars LAN Map

An interactive map of the **Mars College** and **Bombay Beach Neocities** community internet LAN. This project visualizes network devices (UniFi APs/switches and UISP airMax radios), their connections, and wireless signal strength on an OpenLayers map.

## What We're Mapping

The LAN spans Mars College (Slab City) and Bombay Beach, California—a community-built network serving residents and visitors. The map shows:

- **UISP devices** — Ubiquiti airMax radios with GPS coordinates (towers, sectors, client radios)
- **UniFi devices** — Access points and switches (positioned by centroid or manual placement)
- **Links** — Wireless connections between UISP devices (with signal strength in dBm) and wired uplinks between UniFi devices

Data is collected from:

- **UniFi Network Controller** — APs, switches, client counts, uplink topology
- **UISP (Ubiquiti Network Management)** — airMax devices, sites, and data-links with signal metrics

## Project Structure

```
├── network_collector.py       # Fetches data from UniFi + UISP APIs
├── unifi_position_lookup.json # Manual lat/lon overrides for UniFi APs (edit to add measured positions)
├── network_data.json         # Output: devices and links (generated)
├── network_data.tsv          # Output: device list (generated)
├── SPRINT_BOARD.md           # Development tasks and acceptance criteria
└── README.md                 # This file
```

### UniFi Position Lookup

UniFi access points don't have GPS coordinates from the API. The collector uses a centroid of UISP devices as a default. For accurate placement, add manually measured coordinates to `unifi_position_lookup.json`:

```json
{
  "68:d7:9a:d3:b0:22": { "name": "AP - Chiba North - B0:22 - AC LR", "lat": 33.3621568, "lon": -115.7139224 },
  "68:d7:9a:2a:91:e1": { "name": "AP - Chiba Media Lab Ceiling - Nano HD", "lat": 33.3623447, "lon": -115.7139680 }
}
```

Use the device MAC address (id) as the key. When the collector runs, these positions override the centroid for matching devices.

## Quick Start

### 1. Collect Network Data

Create a `.env` file with your API credentials:

```env
UNIFI_URL=https://your-unifi-controller
UNIFI_KEY=your-unifi-api-key
UNIFI_SITE=default

UISP_URL=https://your-uisp-instance
UISP_KEY=your-uisp-auth-token
```

Then run:

```bash
pip install -r requirements.txt
python network_collector.py
```

This produces `network_data.json` and `network_data.tsv`.

### 2. View the Map

Serve the map locally (requires `network_data.json` from step 1):

```bash
# Python 3
python -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

For GitHub Pages, push the repo and enable Pages in Settings → Pages → Source: main branch.

The map:

- Loads `network_data.json` on page load (Refresh button to reload)
- Displays UISP and UniFi devices as points; wireless and wired links as lines
- Styles devices by type (circle=AP, square=switch, triangle=airMax); greys out disconnected
- Shows signal strength via color (green/yellow/red) and line thickness
- Inspector panel on click for device/link details
- Admin mode: enable "Admin (drag UniFi)" to drag UniFi devices; positions persist in localStorage

See [SPRINT_BOARD.md](SPRINT_BOARD.md) for the full roadmap.

## Data Schema

`network_data.json` structure:

```json
{
  "unifi": [{ "id", "name", "type", "model", "state", "clients", "lat", "lon" }],
  "uisp": [{ "id", "name", "model", "type", "state", "lat", "lon" }],
  "links": [{ "from", "to", "type", "state", "signal" }],
  "map_metadata": { "lat_min", "lat_max", "lon_min", "lon_max" }
}
```

- **unifi** — `type`: `uap` (AP) or `usw` (switch); `state`: 1 = online, 0 = offline
- **uisp** — `type`: `airMax`; `state`: `active` or `disconnected`
- **links** — `type`: `wired_unifi` or `wireless`; `signal` in dBm (wireless only)

## License

[Add your license here]
