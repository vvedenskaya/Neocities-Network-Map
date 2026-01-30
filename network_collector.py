"""
Network data collector for Mars College / Bombay Beach Neocities LAN.
Aggregates device and link data from UniFi Network and UISP (Ubiquiti) APIs.
Outputs JSON and TSV for the interactive map visualization.
"""

import json
import os
import csv
import urllib3
import requests
from dotenv import load_dotenv

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
load_dotenv()


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


def format_network_data(unifi_devs, uisp_devs, uisp_sites, uisp_links):
    """
    Combine UniFi and UISP data into a unified structure for the map.
    UniFi devices without coordinates get centroid of UISP devices as default.
    """
    combined = {"unifi": [], "uisp": [], "links": [], "map_metadata": {}}

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

    # UniFi devices
    if isinstance(unifi_devs, list):
        for dev in unifi_devs:
            mac = dev.get("mac")
            uplink_mac = dev.get("uplink_mac") or dev.get("uplink", {}).get("uplink_mac")
            combined["unifi"].append(
                {
                    "id": mac,
                    "name": dev.get("name", mac),
                    "type": dev.get("type"),
                    "model": dev.get("model"),
                    "state": dev.get("state", 1),
                    "clients": dev.get("num_sta", 0),
                    "x": dev.get("x"),
                    "y": dev.get("y"),
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
                        "lat": lat,
                        "lon": lon,
                    }
                )

    # Compute centroid for UniFi default placement (devices without coords)
    centroid_lat = sum(lats) / len(lats) if lats else None
    centroid_lon = sum(lons) / len(lons) if lons else None
    for dev in combined["unifi"]:
        if dev.get("x") is None and dev.get("y") is None and centroid_lat and centroid_lon:
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


def export_to_tsv(data, filename="network_data.tsv"):
    """Export device list to TSV."""
    all_devices = []
    for source in ["uisp", "unifi"]:
        if isinstance(data.get(source), list):
            for device in data[source]:
                all_devices.append(
                    {
                        "name": device.get("name", ""),
                        "model": device.get("model", ""),
                        "type": device.get("type", ""),
                        "state": device.get("state", ""),
                        "lat": device.get("lat", ""),
                        "lon": device.get("lon", ""),
                    }
                )
    if all_devices:
        with open(filename, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["name", "model", "type", "state", "lat", "lon"],
                delimiter="\t",
            )
            writer.writeheader()
            writer.writerows(all_devices)
        print(f"  ✓ Exported {len(all_devices)} devices to {filename}")


def main():
    UNIFI_URL = os.getenv("UNIFI_URL")
    UNIFI_KEY = os.getenv("UNIFI_KEY")
    UNIFI_SITE = os.getenv("UNIFI_SITE", "default")
    UISP_URL = os.getenv("UISP_URL")
    UISP_KEY = os.getenv("UISP_KEY")

    unifi_devices = []
    if UNIFI_URL and UNIFI_KEY:
        unifi_devices = UniFiCollector(
            UNIFI_URL, UNIFI_KEY, site=UNIFI_SITE
        ).get_devices()

    uisp_devices, uisp_sites, uisp_links = [], [], []
    if UISP_URL and UISP_KEY:
        coll = UISPCollector(UISP_URL, UISP_KEY)
        uisp_devices = coll.get_devices()
        uisp_sites = coll.get_sites()
        uisp_links = coll.get_datalinks()

    data = format_network_data(
        unifi_devices, uisp_devices, uisp_sites, uisp_links
    )

    with open("network_data.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    export_to_tsv(data)
    print(
        f"\n--- Results ---\n"
        f"UniFi: {len(data['unifi'])} | UISP: {len(data['uisp'])} | "
        f"Links: {len(data['links'])}"
    )


if __name__ == "__main__":
    main()
