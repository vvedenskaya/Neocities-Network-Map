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
├── network_collector.py   # Fetches data from UniFi + UISP APIs
├── network_data.json     # Output: devices and links (generated)
├── network_data.tsv      # Output: device list (generated)
├── SPRINT_BOARD.md       # Development tasks and acceptance criteria
└── README.md             # This file
```

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

### 2. View the Map (Coming Soon)

The interactive map will be a static web app (HTML/JS + OpenLayers) hosted on GitHub Pages. It will:

- Load `network_data.json` on page load
- Display devices and links on an online map
- Allow filtering, search, and manual placement of UniFi devices
- Show signal strength via color and thickness of connection lines

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
