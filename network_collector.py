"""
Network data collector for Mars College / Bombay Beach Neocities LAN.
Aggregates device and link data from UniFi Network and UISP (Ubiquiti) APIs.
Outputs JSON and TSV for the interactive map visualization.
"""

import argparse
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
TIMELINE_FILES = [TIMELINE_24H, TIMELINE_7D, TIMELINE_30D]


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


def load_timeline_frames(paths):
    """Load frame lists from timeline json files."""
    frames = []
    for path in paths:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                payload = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        file_frames = payload.get("frames", [])
        if isinstance(file_frames, list):
            for frame in file_frames:
                if isinstance(frame, dict):
                    frames.append(frame)
    return frames


def link_key(link):
    """Stable key for link dedup; links are undirected for map line rendering."""
    a = link.get("from")
    b = link.get("to")
    t = link.get("type", "wireless")
    if not a or not b:
        return None
    left, right = sorted([str(a), str(b)])
    return left, right, str(t)


def load_historical_wireless_links():
    """
    Build a merged historical wireless link set from timeline files.
    Uses latest timestamped occurrence per undirected endpoint pair.
    """
    by_key = {}
    for frame in load_timeline_frames(TIMELINE_FILES):
        ts = frame.get("ts", "")
        for link in frame.get("links", []):
            if not isinstance(link, dict):
                continue
            if link.get("type", "wireless") != "wireless":
                continue
            key = link_key(link)
            if key is None:
                continue
            prev = by_key.get(key)
            if prev is None or ts >= prev.get("_ts", ""):
                by_key[key] = {
                    "from": link.get("from"),
                    "to": link.get("to"),
                    "type": "wireless",
                    "state": link.get("state"),
                    "signal": link.get("signal"),
                    "_ts": ts,
                }
    out = []
    for item in by_key.values():
        item.pop("_ts", None)
        out.append(item)
    return out


def enrich_with_historical_uisp_links(combined, site_map, uisp_position_lookup):
    """
    Merge historical UISP links and create placeholder UISP nodes for missing endpoints.
    This allows old cross-location links to remain visible even when endpoints disappear
    from the current live API response.
    """
    historical_links = load_historical_wireless_links()
    if not historical_links:
        return

    existing_link_keys = {k for k in (link_key(l) for l in combined["links"]) if k is not None}
    for link in historical_links:
        key = link_key(link)
        if key is None or key in existing_link_keys:
            continue
        combined["links"].append(link)
        existing_link_keys.add(key)

    # Build current coordinate map from known devices + manual overrides.
    coords = {}
    for dev in combined.get("uisp", []):
        if dev.get("id") and dev.get("lat") is not None and dev.get("lon") is not None:
            coords[dev["id"]] = (float(dev["lat"]), float(dev["lon"]))
    for dev in combined.get("unifi", []):
        if dev.get("id") and dev.get("lat") is not None and dev.get("lon") is not None:
            coords[dev["id"]] = (float(dev["lat"]), float(dev["lon"]))
    for dev_id, pos in uisp_position_lookup.items():
        if pos.get("lat") is not None and pos.get("lon") is not None:
            coords[dev_id] = (float(pos["lat"]), float(pos["lon"]))

    known_uisp_ids = {d.get("id") for d in combined.get("uisp", []) if d.get("id")}

    # Gather missing wireless endpoints that look like UISP UUIDs.
    missing = set()
    neighbors = {}
    for link in combined.get("links", []):
        if link.get("type", "wireless") != "wireless":
            continue
        a = link.get("from")
        b = link.get("to")
        if not a or not b:
            continue
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
        for endpoint in (a, b):
            if endpoint in known_uisp_ids:
                continue
            if isinstance(endpoint, str) and "-" in endpoint and len(endpoint) >= 32:
                missing.add(endpoint)

    # Seed from site coordinates where possible.
    for endpoint in list(missing):
        site = site_map.get(endpoint)
        if site and site.get("lat") is not None and site.get("lon") is not None:
            coords[endpoint] = (float(site["lat"]), float(site["lon"]))

    # Iteratively infer unknown endpoint coords from known neighbors.
    changed = True
    while changed:
        changed = False
        for endpoint in list(missing):
            if endpoint in coords:
                continue
            pts = [coords[n] for n in neighbors.get(endpoint, set()) if n in coords]
            if not pts:
                continue
            lat = sum(p[0] for p in pts) / len(pts)
            lon = sum(p[1] for p in pts) / len(pts)
            # If only one neighbor is known, nudge the synthetic node slightly so
            # the recovered line is visible (not zero-length on top of the neighbor).
            if len(pts) == 1:
                jitter = ((sum(ord(c) for c in endpoint) % 13) - 6) * 0.00003
                lat += jitter
                lon -= jitter
            coords[endpoint] = (lat, lon)
            changed = True

    for endpoint in sorted(missing):
        if endpoint in known_uisp_ids:
            continue
        if endpoint not in coords:
            continue
        site = site_map.get(endpoint, {})
        lat, lon = coords[endpoint]
        combined["uisp"].append(
            {
                "id": endpoint,
                "name": site.get("name") or f"Recovered UISP {endpoint[:8]}",
                "model": "Recovered UISP endpoint",
                "type": "site",
                "state": "active",
                "clients": 0,
                "lat": lat,
                "lon": lon,
            }
        )
        known_uisp_ids.add(endpoint)


def compute_map_metadata(points):
    """
    Build a stable viewport bounding box from coordinate points.
    Applies a median-distance focus filter by default so distant outliers
    don't force an over-zoomed map extent.
    """
    if not points:
        return {}

    lats_all = [p[0] for p in points]
    lons_all = [p[1] for p in points]
    med_lat = sorted(lats_all)[len(lats_all) // 2]
    med_lon = sorted(lons_all)[len(lons_all) // 2]

    focus_filter_deg = float(os.getenv("MAP_FOCUS_FILTER_DEG", "0.03"))
    focused = points
    if focus_filter_deg > 0:
        filtered = [
            (lat, lon)
            for lat, lon in points
            if abs(lat - med_lat) < focus_filter_deg and abs(lon - med_lon) < focus_filter_deg
        ]
        # Only use filtered set when there are enough points to form a meaningful viewport.
        if len(filtered) >= max(5, int(len(points) * 0.2)):
            focused = filtered

    lats = [p[0] for p in focused]
    lons = [p[1] for p in focused]
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    pad_lat = (lat_max - lat_min) * 0.1 or 0.001
    pad_lon = (lon_max - lon_min) * 0.1 or 0.001
    return {
        "lat_min": lat_min - pad_lat,
        "lat_max": lat_max + pad_lat,
        "lon_min": lon_min - pad_lon,
        "lon_max": lon_max + pad_lon,
    }


def load_unifi_position_lookup():
    """Load manually measured UniFi device positions. Returns dict of mac (lowercase) -> {lat, lon}."""
    if not os.path.exists(UNIFI_POSITION_LOOKUP):
        return {}
    try:
        with open(UNIFI_POSITION_LOOKUP, encoding="utf-8") as f:
            data = json.load(f)
        return {
            k.lower(): v for k, v in data.items()
            if not k.startswith("_") and isinstance(v, dict)
        }
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
                    "id": s_id,
                    "name": site.get("name") or site.get("identification", {}).get("name") or s_id,
                    "lat": loc.get("latitude"),
                    "lon": loc.get("longitude"),
                }

    # UniFi devices — only include devices listed in unifi_position_lookup.json (MAC match is case-insensitive). Skip UNUSED/DISABLED.
    if isinstance(unifi_devs, list):
        for dev in unifi_devs:
            mac = dev.get("mac")
            if not mac or mac.lower() not in position_lookup:
                continue
            name = (dev.get("name") or "").upper()
            if "UNUSED" in name or "DISABLED" in name:
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
        # Optional median-distance filter for noisy installs.
        # Default is disabled so cross-location links (e.g. town <-> Mars) are preserved.
        # Set UISP_MEDIAN_FILTER_DEG=0.03 (or another value) to enable.
        median_filter_deg = float(os.getenv("UISP_MEDIAN_FILTER_DEG", "0"))
        for lat, lon, d_id, dev in temp_uisp:
            if median_filter_deg > 0 and (
                abs(lat - med_lat) >= median_filter_deg
                or abs(lon - med_lon) >= median_filter_deg
            ):
                continue
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
        manual = position_lookup.get((dev["id"] or "").lower())
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

    # Some UISP links terminate at site IDs (not device IDs). Add those site endpoints
    # as pseudo UISP nodes so renderLinks() can resolve both sides and draw the line.
    known_ids = {d.get("id") for d in combined["uisp"] if d.get("id")}
    for link in combined["links"]:
        for endpoint in (link.get("from"), link.get("to")):
            if not endpoint or endpoint in known_ids:
                continue
            site = site_map.get(endpoint)
            if not site:
                continue
            lat = site.get("lat")
            lon = site.get("lon")
            if lat is None or lon is None:
                continue
            combined["uisp"].append(
                {
                    "id": endpoint,
                    "name": site.get("name") or f"Site {endpoint}",
                    "model": "UISP Site",
                    "type": "site",
                    "state": "active",
                    "clients": 0,
                    "lat": float(lat),
                    "lon": float(lon),
                }
            )
            known_ids.add(endpoint)

    # Merge historical timeline links and infer missing endpoint coordinates.
    enrich_with_historical_uisp_links(combined, site_map, uisp_position_lookup)

    # Map metadata (bounding box for initial view)
    viewport_points = []
    for dev in combined["uisp"]:
        if dev.get("lat") is not None and dev.get("lon") is not None:
            viewport_points.append((float(dev["lat"]), float(dev["lon"])))
    combined["map_metadata"] = compute_map_metadata(viewport_points)

    return combined


def main():
    parser = argparse.ArgumentParser(description="Collect network data for the map.")
    parser.add_argument(
        "--list-unifi",
        action="store_true",
        help="Print all UniFi devices (mac, name) from API and exit. Use to find MAC for unifi_position_lookup.json",
    )
    args = parser.parse_args()

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

    if args.list_unifi:
        if not unifi_devices:
            print("No UniFi devices (check UNIFI_URL, UNIFI_KEY, UNIFI_SITE).")
        else:
            print("UniFi devices from API (use 'mac' as key in unifi_position_lookup.json):\n")
            for d in sorted(unifi_devices, key=lambda x: (x.get("name") or "")):
                mac = (d.get("mac") or "").lower()
                name = d.get("name") or d.get("mac") or "?"
                print(f"  \"{mac}\": \"{name}\"")
        return

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
