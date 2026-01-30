# Network Data Attributes Guide

This document outlines key attributes from the network discovery JSON, categorized by their utility for network administration and interactive map visualization.

## 1. Network Administration & Debugging
These attributes are essential for troubleshooting, monitoring link stability, and technical auditing.

### Link Health & Stability
*   **`overview.signal`**: Signal strength (e.g., `-58`). Critical for diagnosing physical alignment issues or interference.
*   **`overview.outageScore`**: Reliability metric (0 to 1). High values indicate a stable connection with minimal drops.
*   **`overview.linkScore.linkScoreHint`**: A human-readable summary of link quality (e.g., "This link is great").

### Performance Metrics
*   **`overview.downlinkCapacity` / `uplinkCapacity`**: Maximum theoretical throughput in bps.
*   **`overview.downlinkUtilization` / `uplinkUtilization`**: Real-time load percentage. Helps identify congested sectors.
*   **`overview.mainInterfaceSpeed`**: Physical Ethernet port speed (e.g., "100 Mbps - Full Duplex"). Useful for detecting cable or PoE injector faults.

### Radio & Configuration
*   **`overview.frequency`**: Operating frequency in MHz. Used to map frequency reuse and identify interference.
*   **`overview.channelWidth`**: Channel width (20/40/80 MHz). Affects capacity and noise floor.
*   **`identification.firmwareVersion`**: Current OS version. Essential for security compliance and feature support.
*   **`identification.mac`**: Unique hardware identifier. Crucial for inventory and physical device tracking.
*   **`ipAddress`**: Management IP address. Necessary for remote login and terminal troubleshooting.
*   **`overview.uptime`**: How long the device has been running. Sudden low values indicate power issues or reboots.

---

## 2. Interactive Map & User UI
These attributes focus on spatial context, visual identification, and simplified status reporting for end-users.

### Geospatial Data
*   **`location.latitude` / `longitude`**: Exact coordinates for plotting the device on the map.
*   **`location.altitude` / `elevation`**: Vertical positioning for 3D maps or terrain analysis.

### Visual Identification
*   **`identification.displayName`**: The primary label for the node.
*   **`identification.modelName`**: Hardware model (e.g., "NanoStation 5AC loco"). Can be used to assign specific icons.
*   **`identification.site.name`**: Logical grouping (e.g., "Catherine" site).
*   **`overview.status`**: Connection state (`active`, `disconnected`). Primary driver for icon color (Green/Red).

### Link Visualization (Edges)
*   **`attributes.apDevice.id`**: Connects the current station to its Access Point. Essential for drawing link lines.
*   **`overview.distance`**: Calculated distance between nodes (in meters). Great for line labels.
*   **`attributes.ssid`**: The network name (SSID). Helps users identify which local Wi-Fi they are connected to.
*   **`ipAddress`**: Can be displayed in "Advanced" tooltips or used to create a direct link to the device's web UI.

---

## 3. Implementation Suggestions
*   **Line Color**: Map `overview.signal` to a color scale (Green > -60dB, Yellow -70dB, Red < -80dB).
*   **Line Thickness**: Map `overview.downlinkCapacity` to stroke width to visualize "bandwidth pipes."
*   **Tooltips**: Use `linkScoreHint` and `uptime` to provide quick context without overwhelming the user with raw DBm values.
