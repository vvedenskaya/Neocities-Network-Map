"""
Network data collector for Mars College / Bombay Beach Neocities LAN.
Aggregates device and link data from UniFi Network and UISP (Ubiquiti) APIs.
Outputs JSON and TSV for the interactive map visualization.
"""

import json
import os
from datetime import datetime, timedelta, timezone
import urllib3
import requests
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()

UNIFI_POSITION_LOOKUP = "unifi_position_lookup.json"
UISP_POSITION_LOOKUP = "uisp_position_lookup.json"
HISTORY_DIR = "history"
SNAPSHOT_LOG = os.path.join(HISTORY_DIR, "network_snapshots.jsonl")
TIMELINE_24H = os.path.join(HISTORY_DIR, "timeline_24h.json")
TIMELINE_7D = os.path.join(HISTORY_DIR, "timeline_7d.json")
TIMELINE_30D = os.path.join(HISTORY_DIR, "timeline_30d.json")


def iso_utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso_utc(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def build_snapshot(data):
    """Build compact snapshot frame for timeline playback."""
    frame = {
        "ts": iso_utc_now(),
        "devices": [],
        "links": [],
    }
    for dev in data.get("unifi", []):
        frame["devices"].append(
            {
                "id": dev.get("id"),
                "source": "unifi",
                "state": dev.get("state"),
                "clients": dev.get("clients", 0),
                "tx_bytes": dev.get("tx_bytes"),
                "rx_bytes": dev.get("rx_bytes"),
            }
        )
    for dev in data.get("uisp", []):
        frame["devices"].append(
            {
                "id": dev.get("id"),
                "source": "uisp",
                "state": dev.get("state"),
                "clients": dev.get("clients", 0),
                "tx_bytes": dev.get("tx_bytes"),
                "rx_bytes": dev.get("rx_bytes"),
            }
        )
    for link in data.get("links", []):
        frame["links"].append(
            {
                "from": link.get("from"),
                "to": link.get("to"),
                "type": link.get("type"),
                "state": link.get("state"),
                "signal": link.get("signal"),
            }
        )
    return frame


def append_snapshot(frame):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    with open(SNAPSHOT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(frame, ensure_ascii=False) + "\n")


def load_recent_snapshots(hours=24):
    if not os.path.exists(SNAPSHOT_LOG):
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    snapshots = []
    with open(SNAPSHOT_LOG, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = parse_iso_utc(item.get("ts"))
            if ts is None:
                continue
            if ts >= cutoff:
                snapshots.append(item)
    snapshots.sort(key=lambda x: x.get("ts", ""))
    return snapshots


def bucket_snapshots(snapshots, bucket_minutes):
    """Keep latest frame in each time bucket for smoother playback performance."""
    if not snapshots:
        return []
    bucketed = {}
    bucket_sec = bucket_minutes * 60
    for frame in snapshots:
        ts = parse_iso_utc(frame.get("ts"))
        if ts is None:
            continue
        bucket_key = int(ts.timestamp()) // bucket_sec
        existing = bucketed.get(bucket_key)
        if existing is None or frame.get("ts", "") > existing.get("ts", ""):
            bucketed[bucket_key] = frame
    return [bucketed[k] for k in sorted(bucketed.keys())]


def write_timeline(path, hours, bucket_minutes):
    snapshots = load_recent_snapshots(hours=hours)
    frames = bucket_snapshots(snapshots, bucket_minutes=bucket_minutes)
    os.makedirs(HISTORY_DIR, exist_ok=True)
    payload = {
        "generated_at": iso_utc_now(),
        "range_hours": hours,
        "bucket_minutes": bucket_minutes,
        "frames": frames,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    return len(frames)


def write_timeline_24h():
    return write_timeline(TIMELINE_24H, hours=24, bucket_minutes=10)


def write_timeline_7d():
    return write_timeline(TIMELINE_7D, hours=24 * 7, bucket_minutes=60)


def write_timeline_30d():
    return write_timeline(TIMELINE_30D, hours=24 * 30, bucket_minutes=180)


def load_unifi_position_lookup():
    """Load manually measured UniFi device positions. Returns dict of mac -> {lat, lon}."""
    if not os.path.exists(UNIFI_POSITION_LOOKUP):
        return {}
    try:
        with open(UNIFI_POSITION_LOOKUP, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, dict)}
    except (json.JSONDecodeError, OSError):
        return {}


def load_uisp_position_lookup():
    """Load manually adjusted UISP device positions (from map drag). Returns dict of device_id -> {lat, lon}."""
    if not os.path.exists(UISP_POSITION_LOOKUP):
        return {}
    try:
        with open(UISP_POSITION_LOOKUP, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, dict)}
    except (json.JSONDecodeError, OSError):
        return {}


class UniFiCollector:
    """Collects devices from UniFi Network Controller API."""

    def __init__(self, base_url, api_key, site="default"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.site = site
        self.session = requests.Session()
        self.session.headers.update(
            {
                "x-api-key": self.api_key,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0",
            }
        )

    def get_devices(self):
        paths = [
            f"/proxy/network/integration/v1/sites/{self.site}/devices",
            f"/proxy/network/api/s/{self.site}/stat/device",
            f"/api/s/{self.site}/stat/device",
        ]
        for path in paths:
            url = f"{self.base_url}{path}"
            try:
                response = self.session.get(url, verify=False, timeout=15)
                if response.status_code == 200:
                    try:
                        res_json = response.json()
                        if isinstance(res_json, list):
                            return res_json
                        return res_json.get("data", [])
                    except (ValueError, TypeError):
                        continue
            except requests.RequestException:
                continue
        return []

    def get_clients(self):
        """Fetch connected clients from UniFi controller."""
        paths = [
            f"/proxy/network/api/s/{self.site}/stat/sta",
            f"/api/s/{self.site}/stat/sta",
        ]
        for path in paths:
            url = f"{self.base_url}{path}"
            try:
                response = self.session.get(url, verify=False, timeout=15)
                if response.status_code == 200:
                    try:
                        res_json = response.json()
                        if isinstance(res_json, list):
                            return res_json
                        return res_json.get("data", [])
                    except (ValueError, TypeError):
                        continue
            except requests.RequestException:
                continue
        return []


class UISPCollector:
    """Collects devices, sites, and data-links from UISP API."""

    def __init__(self, base_url, api_key):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update(
            {"x-auth-token": self.api_key, "Accept": "application/json"}
        )

    def get_devices(self):
        url = f"{self.base_url}/nms/api/v2.1/devices"
        try:
            response = self.session.get(url, verify=False, timeout=15)
            if response.status_code == 200:
                return response.json()
        except requests.RequestException:
            pass
        return []

    def get_sites(self):
        url = f"{self.base_url}/nms/api/v2.1/sites"
        try:
            response = self.session.get(url, verify=False, timeout=15)
            if response.status_code == 200:
                return response.json()
        except requests.RequestException:
            pass
        return []

    def get_datalinks(self):
        url = f"{self.base_url}/nms/api/v2.1/data-links?siteLinksOnly=true"
        try:
            response = self.session.get(url, verify=False, timeout=15)
            if response.status_code == 200:
                return response.json()
        except requests.RequestException:
            pass
        return []


def format_network_data(unifi_devs, uisp_devs, uisp_sites, uisp_links, unifi_clients=None):
    """
    Combine UniFi and UISP data into a unified structure for the map.
    UniFi device coordinates: manual lookup > API x/y > centroid of UISP devices.
    """
    combined = {"unifi": [], "uisp": [], "links": [], "map_metadata": {}}
    position_lookup = load_unifi_position_lookup()
    uisp_position_lookup = load_uisp_position_lookup()

    # Build client lookup: device_mac -> [list of client dicts]
    # Wi-Fi clients use ap_mac; wired clients (on switches) use sw_mac
    client_map = {}
    for c in (unifi_clients or []):
        device_mac = c.get("ap_mac") or c.get("sw_mac")
        if not device_mac:
            continue
        client_map.setdefault(device_mac, []).append({
            "mac": c.get("mac"),
            "name": c.get("name") or c.get("hostname") or c.get("oui") or c.get("mac"),
            "ip": c.get("ip"),
            "rssi": c.get("rssi"),
            "signal": c.get("signal"),
            "tx_bytes": c.get("tx_bytes"),
            "rx_bytes": c.get("rx_bytes"),
            "uptime": c.get("uptime"),
            "os": c.get("os_name") or c.get("dev_cat"),
            "radio": c.get("radio_proto"),
            "channel": c.get("channel"),
        })

    # Build site coords lookup
    site_map = {}
    if isinstance(uisp_sites, list):
        for site in uisp_sites:
            s_id = site.get("id")
            loc = site.get("location") or {}
            if s_id:
                site_map[s_id] = {
                    "lat": loc.get("latitude"),
                    "lon": loc.get("longitude"),
                }

    # UniFi devices — only include devices listed in unifi_position_lookup.json
    if isinstance(unifi_devs, list):
        for dev in unifi_devs:
            mac = dev.get("mac")
            if mac not in position_lookup:
                continue
            uplink_mac = dev.get("uplink_mac") or dev.get("uplink", {}).get("uplink_mac")
            combined["unifi"].append(
                {
                    "id": mac,
                    "name": dev.get("name", mac),
                    "type": dev.get("type"),
                    "model": dev.get("model"),
                    "state": dev.get("state", 1),
                    "clients": dev.get("num_sta", 0),
                    "client_list": client_map.get(mac, []),
                    "x": dev.get("x"),
                    "y": dev.get("y"),
                    "ip": dev.get("ip"),
                    "version": dev.get("version"),
                    "uptime": dev.get("uptime"),
                    "tx_bytes": dev.get("tx_bytes"),
                    "rx_bytes": dev.get("rx_bytes"),
                }
            )
            if uplink_mac:
                combined["links"].append(
                    {"from": uplink_mac, "to": mac, "type": "wired_unifi"}
                )

    # UISP devices with coordinates
    lats, lons = [], []
    temp_uisp = []
    if isinstance(uisp_devs, list):
        for dev in uisp_devs:
            id_info = dev.get("identification") or {}
            attr = dev.get("attributes") or {}
            loc = dev.get("location") or {}
            s_id = id_info.get("siteId")
            d_id = id_info.get("id")
            site_coords = site_map.get(s_id, {})
            lat = (
                attr.get("latitude")
                or loc.get("latitude")
                or site_coords.get("lat")
            )
            lon = (
                attr.get("longitude")
                or loc.get("longitude")
                or site_coords.get("lon")
            )
            if lat and lon:
                lat, lon = float(lat), float(lon)
                if abs(lat) > 0.1:
                    temp_uisp.append((lat, lon, d_id, dev))

    if temp_uisp:
        all_lats = sorted([x[0] for x in temp_uisp])
        all_lons = sorted([x[1] for x in temp_uisp])
        med_lat = all_lats[len(all_lats) // 2]
        med_lon = all_lons[len(all_lons) // 2]
        for lat, lon, d_id, dev in temp_uisp:
            if abs(lat - med_lat) < 0.03 and abs(lon - med_lon) < 0.03:
                lats.append(lat)
                lons.append(lon)
                id_info = dev.get("identification") or {}
                combined["uisp"].append(
                    {
                        "id": d_id,
                        "name": id_info.get("name"),
                        "model": id_info.get("model"),
                        "type": id_info.get("type"),
                        "state": dev.get("overview", {}).get("status"),
                        "clients": dev.get("overview", {}).get("stationsCount", 0),
                        "lat": lat,
                        "lon": lon,
                    }
                )

    # Apply manual UISP position overrides (from map drag & export)
    for dev in combined["uisp"]:
        override = uisp_position_lookup.get(dev["id"])
        if override and override.get("lat") is not None and override.get("lon") is not None:
            dev["lat"] = float(override["lat"])
            dev["lon"] = float(override["lon"])

    # Assign coordinates to UniFi devices: manual lookup > API x/y > centroid
    centroid_lat = sum(lats) / len(lats) if lats else None
    centroid_lon = sum(lons) / len(lons) if lons else None
    for dev in combined["unifi"]:
        manual = position_lookup.get(dev["id"])
        if manual and manual.get("lat") is not None and manual.get("lon") is not None:
            dev["lat"] = float(manual["lat"])
            dev["lon"] = float(manual["lon"])
        elif dev.get("x") is not None and dev.get("y") is not None:
            dev["lat"] = float(dev["y"])
            dev["lon"] = float(dev["x"])
        elif centroid_lat and centroid_lon:
            dev["lat"] = centroid_lat
            dev["lon"] = centroid_lon

    # UISP links
    if isinstance(uisp_links, list):
        for link in uisp_links:
            from_data = link.get("from") or {}
            to_data = link.get("to") or {}
            from_dev_ident = (from_data.get("device") or {}).get("identification") or {}
            from_site_ident = (from_data.get("site") or {}).get("identification") or {}
            to_dev_ident = (to_data.get("device") or {}).get("identification") or {}
            to_site_ident = (to_data.get("site") or {}).get("identification") or {}
            side_a = (
                from_dev_ident.get("id")
                or from_site_ident.get("id")
                or link.get("deviceIdA")
                or link.get("siteIdA")
            )
            side_b = (
                to_dev_ident.get("id")
                or to_site_ident.get("id")
                or link.get("deviceIdB")
                or link.get("siteIdB")
            )
            if side_a and side_b:
                signal = link.get("signal") or (from_data.get("device") or {}).get(
                    "overview", {}
                ).get("signal")
                combined["links"].append(
                    {
                        "from": side_a,
                        "to": side_b,
                        "type": link.get("type", "wireless"),
                        "state": link.get("state", "active"),
                        "signal": signal,
                    }
                )

    # Map metadata (bounding box for initial view)
    if lats and lons:
        lat_min, lat_max = min(lats), max(lats)
        lon_min, lon_max = min(lons), max(lons)
        pad_lat = (lat_max - lat_min) * 0.1 or 0.001
        pad_lon = (lon_max - lon_min) * 0.1 or 0.001
        combined["map_metadata"] = {
            "lat_min": lat_min - pad_lat,
            "lat_max": lat_max + pad_lat,
            "lon_min": lon_min - pad_lon,
            "lon_max": lon_max + pad_lon,
        }

    return combined


def main():
    UNIFI_URL = os.getenv("UNIFI_URL")
    UNIFI_KEY = os.getenv("UNIFI_KEY")
    UNIFI_SITE = os.getenv("UNIFI_SITE", "default")
    UISP_URL = os.getenv("UISP_URL")
    UISP_KEY = os.getenv("UISP_KEY")

    unifi_devices = []
    unifi_clients = []
    if UNIFI_URL and UNIFI_KEY:
        unifi_col = UniFiCollector(UNIFI_URL, UNIFI_KEY, site=UNIFI_SITE)
        unifi_devices = unifi_col.get_devices()
        unifi_clients = unifi_col.get_clients()

    uisp_devices, uisp_sites, uisp_links = [], [], []
    if UISP_URL and UISP_KEY:
        coll = UISPCollector(UISP_URL, UISP_KEY)
        uisp_devices = coll.get_devices()
        uisp_sites = coll.get_sites()
        uisp_links = coll.get_datalinks()

    data = format_network_data(
        unifi_devices, uisp_devices, uisp_sites, uisp_links, unifi_clients
    )

    with open("network_data.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    snapshot = build_snapshot(data)
    append_snapshot(snapshot)
    timeline_24h_frames = write_timeline_24h()
    timeline_7d_frames = write_timeline_7d()
    timeline_30d_frames = write_timeline_30d()

    print(
        f"\n--- Results ---\n"
        f"UniFi: {len(data['unifi'])} | UISP: {len(data['uisp'])} | "
        f"Links: {len(data['links'])}\n"
        f"Timeline frames — 24h: {timeline_24h_frames}, "
        f"7d: {timeline_7d_frames}, 30d: {timeline_30d_frames}"
    )


if __name__ == "__main__":
    main()
