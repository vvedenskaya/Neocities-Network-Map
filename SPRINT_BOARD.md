# Bombay Mars LAN Map — Sprint Board

Interactive map visualization of the Mars College and Bombay Beach Neocities LAN, built with OpenLayers. Data sourced from UniFi Network and UISP APIs via `network_collector.py`.

---

## Data Overview

| Source | Devices | Coordinates | IDs |
|--------|---------|-------------|-----|
| **UniFi** | APs (uap), Switches (usw) | Centroid default; admin can drag & persist | MAC |
| **UISP** | airMax radios | lat/lon from API | UUID |
| **Links** | wired_unifi (UniFi↔UniFi), wireless (UISP↔UISP) | — | signal (dBm) for wireless |

---

## MVP Sprint 1 — Core Map

### Epic: Map Foundation

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M1.1 | Set up OpenLayers map with online tiles (OSM/Stadia/Bing) | Map loads, pans, zooms; initial view from `map_metadata` |
| M1.2 | Load `network_data.json` on page load | Data fetched and parsed; handle missing file gracefully |
| M1.3 | Add refresh button to reload JSON | Button triggers re-fetch; map updates with new data |

### Epic: Device Points

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M1.4 | Render UISP devices as points on map | Each UISP device with lat/lon appears as a marker |
| M1.5 | Render UniFi devices: centroid default | UniFi without coords uses centroid of all UISP; devices with lat/lon use those |
| M1.6 | Style devices by type: shape & size | Different shapes/sizes for uap, usw, airMax (e.g. circle vs square, small vs large) |
| M1.7 | Grey out disconnected devices | `state` = disconnected/0 → muted/grey styling |
| M1.8 | Click/hover → select device | Selected device highlighted; inspector panel shows details |

### Epic: Connection Lines

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M1.9 | Draw wireless links between UISP devices | LineStrings from `from`→`to` using device coordinates |
| M1.10 | Draw wired_unifi links | Only when both endpoints have coordinates (after centroid or manual placement) |
| M1.11 | Signal strength: color + thickness | Color gradient (e.g. green > -55 dBm, yellow -55 to -65, red < -65); thickness scales with signal |
| M1.12 | Signal on selection: tooltip / inspector | Selected link shows exact dBm; inspector panel displays signal value |

### Epic: Inspector Panel

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M1.13 | Inspector panel for selected node | Shows name, model, type, state, clients (UniFi), lat/lon |
| M1.14 | Device model thumbnail in inspector | Thumbnail image for selected device model (e.g. Loco5AC, U7LR) |
| M1.15 | Inspector for selected link | Shows from/to, type, state, signal (dBm) |

### Epic: UniFi Manual Placement

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M1.16 | Admin mode: drag UniFi devices | Draggable markers for UniFi devices; update position on drop |
| M1.17 | Persist manual placements | Save overrides (e.g. `device_positions.json` or localStorage); load on next visit |
| M1.18 | Merge persisted positions with data | Override collector lat/lon with saved positions when rendering |

---

## MVP Sprint 2 — Filtering & Layers

### Epic: Toggleable Layers

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M2.1 | Layer: UISP devices | Toggle visibility of UISP points |
| M2.2 | Layer: UniFi devices | Toggle visibility of UniFi points |
| M2.3 | Layer: Wireless links | Toggle visibility of wireless connections |
| M2.4 | Layer: Wired links | Toggle visibility of wired_unifi connections |
| M2.5 | Filter: link state (active/disconnected) | Toggle to show/hide disconnected links |
| M2.6 | Filter: signal strength threshold | Slider or input: only show links weaker than X dBm (e.g. -60) |
| M2.7 | Filter: device type | Checkboxes to show/hide uap, usw, airMax |

---

## Post-MVP Sprint 3 — Polish

### Epic: Search & Navigation

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M3.1 | Search by device name | Search input; filter/zoom to matching devices |
| M3.2 | Zoom-to-device | Click in search results or list → pan/zoom map to device |
| M3.3 | Legend | Legend showing device shapes, link colors, signal scale |

### Epic: Responsive & UX

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M3.4 | Mobile-friendly layout | Map and controls usable on small screens |
| M3.5 | Touch support | Pan, zoom, tap to select work on touch devices |

### Epic: Export (Future)

| ID | Task | Acceptance Criteria |
|----|------|---------------------|
| M3.6 | Export to GeoJSON | Button to export current view/data as GeoJSON (deferred) |

---

## Technical Notes

- **Hosting**: GitHub Pages (static HTML/JS)
- **Data**: `network_data.json` loaded on page load; refresh button to re-fetch
- **Persistence**: Manual device positions stored separately (JSON file or localStorage); merged at render time
- **Map tiles**: Online only (OSM, Stadia, Bing); no stitched/static images
- **Device thumbnails**: Use Ubiquiti product images or placeholder; consider CDN or local assets

---

## Dependencies

- OpenLayers (latest, e.g. v10.x)
- No backend required for MVP; static hosting only

---

## Definition of Done

- [ ] All MVP tasks complete
- [ ] Works in Chrome, Firefox, Safari
- [ ] No console errors on load
- [ ] README has run instructions for collector + map
