"""
Rebuild a portable network links/nodes archive from history files.

Inputs:
  - history/network_snapshots.jsonl
  - history/timeline_24h.json
  - history/timeline_7d.json
  - history/timeline_30d.json

Outputs (default: history/recovered):
  - recovery_summary.json
  - recovered_latest_topology.json
  - recovered_nodes.json
  - recovered_links.json
  - recovered_frames_index.json
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple


def parse_iso_utc(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def iso(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def load_snapshots_jsonl(path: str) -> List[dict]:
    frames: List[dict] = []
    if not os.path.exists(path):
        return frames
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(frame, dict):
                frames.append(frame)
    return frames


def load_timeline_frames(path: str) -> List[dict]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    frames = payload.get("frames", [])
    if not isinstance(frames, list):
        return []
    return [x for x in frames if isinstance(x, dict)]


def iter_history_frames(history_dir: str) -> Tuple[List[dict], Dict[str, int]]:
    snapshots_path = os.path.join(history_dir, "network_snapshots.jsonl")
    t24_path = os.path.join(history_dir, "timeline_24h.json")
    t7_path = os.path.join(history_dir, "timeline_7d.json")
    t30_path = os.path.join(history_dir, "timeline_30d.json")

    snapshots = load_snapshots_jsonl(snapshots_path)
    timeline_24h = load_timeline_frames(t24_path)
    timeline_7d = load_timeline_frames(t7_path)
    timeline_30d = load_timeline_frames(t30_path)

    raw_counts = {
        "snapshots_jsonl": len(snapshots),
        "timeline_24h": len(timeline_24h),
        "timeline_7d": len(timeline_7d),
        "timeline_30d": len(timeline_30d),
    }

    merged = snapshots + timeline_24h + timeline_7d + timeline_30d
    # Deduplicate frames by timestamp (timelines are bucketed subsets of snapshots).
    by_ts: Dict[str, dict] = {}
    for frame in merged:
        ts = frame.get("ts")
        if not isinstance(ts, str):
            continue
        if ts in by_ts:
            # Prefer richer frame (more devices + links).
            prev = by_ts[ts]
            prev_score = len(prev.get("devices", [])) + len(prev.get("links", []))
            cur_score = len(frame.get("devices", [])) + len(frame.get("links", []))
            if cur_score > prev_score:
                by_ts[ts] = frame
        else:
            by_ts[ts] = frame

    frames = list(by_ts.values())
    frames.sort(key=lambda x: x.get("ts", ""))
    return frames, raw_counts


def normalize_link_key(link: dict) -> Optional[Tuple[str, str, str]]:
    a = link.get("from")
    b = link.get("to")
    t = link.get("type") or "wireless"
    if not a or not b:
        return None
    # Treat links as undirected for archive stability.
    left, right = sorted([str(a), str(b)])
    return (left, right, str(t))


def summarize(frames: Iterable[dict]) -> dict:
    node_stats: Dict[Tuple[str, str], dict] = {}
    link_stats: Dict[Tuple[str, str, str], dict] = {}
    frame_index: List[dict] = []

    first_ts: Optional[datetime] = None
    last_ts: Optional[datetime] = None

    for frame in frames:
        ts_s = frame.get("ts")
        ts = parse_iso_utc(ts_s)
        if ts is None:
            continue
        if first_ts is None or ts < first_ts:
            first_ts = ts
        if last_ts is None or ts > last_ts:
            last_ts = ts

        devices = frame.get("devices", [])
        links = frame.get("links", [])
        frame_index.append(
            {
                "ts": ts_s,
                "devices_count": len(devices) if isinstance(devices, list) else 0,
                "links_count": len(links) if isinstance(links, list) else 0,
            }
        )

        if isinstance(devices, list):
            for dev in devices:
                if not isinstance(dev, dict):
                    continue
                dev_id = dev.get("id")
                source = dev.get("source")
                if not dev_id or not source:
                    continue
                key = (str(source), str(dev_id))
                cur = node_stats.get(key)
                if cur is None:
                    cur = {
                        "source": str(source),
                        "id": str(dev_id),
                        "first_seen": ts,
                        "last_seen": ts,
                        "seen_count": 0,
                        "state_counts": Counter(),
                        "max_clients": 0,
                        "latest_clients": None,
                        "latest_state": None,
                        "latest_tx_bytes": None,
                        "latest_rx_bytes": None,
                    }
                    node_stats[key] = cur

                cur["seen_count"] += 1
                cur["first_seen"] = min(cur["first_seen"], ts)
                cur["last_seen"] = max(cur["last_seen"], ts)
                state = dev.get("state")
                cur["state_counts"][str(state)] += 1
                clients = dev.get("clients")
                if isinstance(clients, int):
                    cur["max_clients"] = max(cur["max_clients"], clients)
                    cur["latest_clients"] = clients
                cur["latest_state"] = state
                cur["latest_tx_bytes"] = dev.get("tx_bytes")
                cur["latest_rx_bytes"] = dev.get("rx_bytes")

        if isinstance(links, list):
            for link in links:
                if not isinstance(link, dict):
                    continue
                key = normalize_link_key(link)
                if key is None:
                    continue
                cur = link_stats.get(key)
                if cur is None:
                    cur = {
                        "from": key[0],
                        "to": key[1],
                        "type": key[2],
                        "first_seen": ts,
                        "last_seen": ts,
                        "seen_count": 0,
                        "state_counts": Counter(),
                        "latest_state": None,
                        "latest_signal": None,
                        "signal_min": None,
                        "signal_max": None,
                        "signal_sum": 0.0,
                        "signal_samples": 0,
                        "directions_seen": set(),
                    }
                    link_stats[key] = cur

                cur["seen_count"] += 1
                cur["first_seen"] = min(cur["first_seen"], ts)
                cur["last_seen"] = max(cur["last_seen"], ts)
                state = link.get("state")
                cur["state_counts"][str(state)] += 1
                cur["latest_state"] = state
                signal = link.get("signal")
                if isinstance(signal, (int, float)):
                    cur["latest_signal"] = signal
                    cur["signal_samples"] += 1
                    cur["signal_sum"] += float(signal)
                    if cur["signal_min"] is None or signal < cur["signal_min"]:
                        cur["signal_min"] = signal
                    if cur["signal_max"] is None or signal > cur["signal_max"]:
                        cur["signal_max"] = signal
                direction = f"{link.get('from')}->{link.get('to')}"
                cur["directions_seen"].add(direction)

    nodes_out = []
    for n in node_stats.values():
        state_counts = dict(sorted(n["state_counts"].items(), key=lambda kv: kv[0]))
        nodes_out.append(
            {
                "source": n["source"],
                "id": n["id"],
                "first_seen": iso(n["first_seen"]),
                "last_seen": iso(n["last_seen"]),
                "seen_count": n["seen_count"],
                "state_counts": state_counts,
                "latest_state": n["latest_state"],
                "latest_clients": n["latest_clients"],
                "max_clients": n["max_clients"],
                "latest_tx_bytes": n["latest_tx_bytes"],
                "latest_rx_bytes": n["latest_rx_bytes"],
            }
        )
    nodes_out.sort(key=lambda x: (x["source"], x["id"]))

    links_out = []
    for l in link_stats.values():
        state_counts = dict(sorted(l["state_counts"].items(), key=lambda kv: kv[0]))
        avg_signal = None
        if l["signal_samples"] > 0:
            avg_signal = l["signal_sum"] / l["signal_samples"]
        links_out.append(
            {
                "from": l["from"],
                "to": l["to"],
                "type": l["type"],
                "first_seen": iso(l["first_seen"]),
                "last_seen": iso(l["last_seen"]),
                "seen_count": l["seen_count"],
                "state_counts": state_counts,
                "latest_state": l["latest_state"],
                "latest_signal": l["latest_signal"],
                "signal_min": l["signal_min"],
                "signal_max": l["signal_max"],
                "signal_avg": avg_signal,
                "directions_seen": sorted(l["directions_seen"]),
            }
        )
    links_out.sort(key=lambda x: (x["type"], x["from"], x["to"]))

    latest_frame = frame_index[-1]["ts"] if frame_index else None
    latest_frame_obj = None
    if latest_frame is not None:
        # Caller already has ordered frames; keep a compact lookup for latest.
        for f in reversed(list(frames)):
            if f.get("ts") == latest_frame:
                latest_frame_obj = {
                    "ts": f.get("ts"),
                    "devices": f.get("devices", []),
                    "links": f.get("links", []),
                }
                break

    return {
        "range_start": iso(first_ts),
        "range_end": iso(last_ts),
        "frames_count": len(frame_index),
        "nodes_count": len(nodes_out),
        "links_count": len(links_out),
        "frames_index": frame_index,
        "nodes": nodes_out,
        "links": links_out,
        "latest_topology": latest_frame_obj or {"ts": None, "devices": [], "links": []},
    }


def write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rebuild network links/nodes archive from history snapshots and timeline files."
    )
    parser.add_argument(
        "--history-dir",
        default="history",
        help="Directory containing network_snapshots.jsonl and timeline_*.json",
    )
    parser.add_argument(
        "--out-dir",
        default=os.path.join("history", "recovered"),
        help="Output directory for reconstructed archive files",
    )
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    frames, raw_counts = iter_history_frames(args.history_dir)
    summary = summarize(frames)

    write_json(
        os.path.join(args.out_dir, "recovery_summary.json"),
        {
            "generated_at": iso(datetime.now(timezone.utc)),
            "input_counts": raw_counts,
            "deduplicated_frames": summary["frames_count"],
            "range_start": summary["range_start"],
            "range_end": summary["range_end"],
            "nodes_count": summary["nodes_count"],
            "links_count": summary["links_count"],
            "notes": [
                "Archive reconstructed from history snapshots + timeline files.",
                "Topology (links, states, signal history) is recoverable.",
                "Display metadata like lat/lon and friendly names is not present in snapshots.",
            ],
        },
    )
    write_json(
        os.path.join(args.out_dir, "recovered_latest_topology.json"),
        summary["latest_topology"],
    )
    write_json(
        os.path.join(args.out_dir, "recovered_nodes.json"),
        {
            "range_start": summary["range_start"],
            "range_end": summary["range_end"],
            "frames_count": summary["frames_count"],
            "nodes": summary["nodes"],
        },
    )
    write_json(
        os.path.join(args.out_dir, "recovered_links.json"),
        {
            "range_start": summary["range_start"],
            "range_end": summary["range_end"],
            "frames_count": summary["frames_count"],
            "links": summary["links"],
        },
    )
    write_json(
        os.path.join(args.out_dir, "recovered_frames_index.json"),
        {
            "range_start": summary["range_start"],
            "range_end": summary["range_end"],
            "frames_count": summary["frames_count"],
            "frames": summary["frames_index"],
        },
    )

    print(
        f"Recovered archive written to {args.out_dir}\n"
        f"Frames: {summary['frames_count']} | Nodes: {summary['nodes_count']} | Links: {summary['links_count']}"
    )


if __name__ == "__main__":
    main()
