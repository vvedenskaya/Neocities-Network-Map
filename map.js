/**
 * Bombay Mars LAN Map - Sprint 1
 * Interactive map of Mars College / Bombay Beach Neocities network.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'bombay-mars-device-positions';
  const DATA_URL = 'network_data.json';
  const TIMELINE_URLS = {
    '24h': 'history/timeline_24h.json',
    '7d': 'history/timeline_7d.json',
    '30d': 'history/timeline_30d.json',
  };

  const PALETTE = {
    unifi_ap:     '#4ecdc4',  // teal  – UniFi access point
    unifi_sw:     '#5b9cf6',  // blue  – UniFi switch
    unifi_gw:     '#a78bfa',  // purple – UniFi gateway / UDM
    uisp:         '#ff8c42',  // orange – all UISP devices
    offline:      '#4b5563',  // dark grey – any offline device
    link_wireless:'#34a853',  // green baseline (overridden by signal)
    link_wired:   '#5b9cf6',  // blue – wired UniFi
    link_uisp:    '#ff8c42',  // orange – UISP wireless
    flow_tx:      '#4ecdc4',  // teal dots – tx (upload)
    flow_rx:      '#ff8c42',  // orange dots – rx (download)
    client_wired: '#a78bfa',  // lavender – wired clients
  };

  // Device model thumbnails (Ubiquiti product images or placeholder)
  const MODEL_IMAGES = {
    'U7LR': 'https://images.ubnt.com/ubnt/products/u7-lr/ubnt-u7-lr-front.png',
    'U7MSH': 'https://images.ubnt.com/ubnt/products/u7-mesh/ubnt-u7-mesh-front.png',
    'U7PG2': 'https://images.ubnt.com/ubnt/products/u7-pro/ubnt-u7-pro-front.png',
    'UKPW': 'https://images.ubnt.com/ubnt/products/u7-outdoor/ubnt-u7-outdoor-front.png',
    'U7LT': 'https://images.ubnt.com/ubnt/products/u7-lite/ubnt-u7-lite-front.png',
    'U7NHD': 'https://images.ubnt.com/ubnt/products/u7-nano-hd/ubnt-u7-nano-hd-front.png',
    'US8P60': 'https://images.ubnt.com/ubnt/products/us-8-60w/ubnt-us-8-60w-front.png',
    'US8P150': 'https://images.ubnt.com/ubnt/products/us-8-150w/ubnt-us-8-150w-front.png',
    'Loco5AC': 'https://images.ubnt.com/ubnt/products/loco5ac/ubnt-loco5ac-front.png',
    'LBE-5AC-Gen2': 'https://images.ubnt.com/ubnt/products/lbe-5ac-gen2/ubnt-lbe-5ac-gen2-front.png',
    'NBE-5AC-Gen2': 'https://images.ubnt.com/ubnt/products/nbe-5ac-gen2/ubnt-nbe-5ac-gen2-front.png',
    'LAP-GPS': 'https://images.ubnt.com/ubnt/products/lap-gps/ubnt-lap-gps-front.png',
    'LAP-120': 'https://images.ubnt.com/ubnt/products/lap-120/ubnt-lap-120-front.png',
  };

  // Signal strength color gradient (dBm -> color)
  function signalColor(dbm) {
    if (dbm == null || dbm === undefined) return '#9aa0a6';
    if (dbm >= -55) return '#34a853'; // green
    if (dbm >= -65) return '#f9ab00';  // yellow
    return '#ea4335';                  // red
  }

  function signalWidth(dbm) {
    if (dbm == null || dbm === undefined) return 2;
    const strength = Math.max(-90, Math.min(-40, dbm));
    return 2 + ((strength + 90) / 50) * 4; // 2–6px
  }

  let map;
  let deviceLayer;
  let linkLayer;
  let clientLayer;
  let clientLinkLayer;
  let streetLayer;
  let satelliteLayer;
  let droneLayer = null;
  let networkData = null;
  let deviceFeatures = new Map();
  let linkFeatures = new Map();
  let clientFeatures = new Map(); // mac -> {dot: Feature, link: Feature, apId: string}
  let selectedFeature = null;
  let adminMode = false;
  let baseNetworkData = null;
  let timelineFrames = [];
  let timelinePlaying = false;
  let timelineTimer = null;
  let timelineFrameIdx = 0;
  let timelineRange = '24h';

  const filters = {
    showUisp: true,
    showUnifi: true,
    showWireless: true,
    showWired: true,
    showClients: true,
    onlineOnly: false,
    minSignal: -90
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function linkKey(link) {
    return `${link.from}::${link.to}::${link.type || ''}`;
  }

  function getDeviceCoords(dev, source) {
    const overrides = loadPositionOverrides();
    const override = overrides[dev.id];
    if (override) return { lat: override.lat, lon: override.lon };
    if (dev.lat != null && dev.lon != null) return { lat: dev.lat, lon: dev.lon };
    if (dev.x != null && dev.y != null) return { lat: dev.y, lon: dev.x };
    return null;
  }

  function computeCentroid(uispDevices) {
    const withCoords = (uispDevices || []).filter(d => d.lat != null && d.lon != null);
    if (withCoords.length === 0) return null;
    const lat = withCoords.reduce((s, d) => s + d.lat, 0) / withCoords.length;
    const lon = withCoords.reduce((s, d) => s + d.lon, 0) / withCoords.length;
    return { lat, lon };
  }

  function resolveDevicePosition(dev, source, centroid) {
    const coords = getDeviceCoords(dev, source);
    if (coords) return coords;
    if (centroid) return centroid; // Позволяем UISP тоже падать в центроид
    return null;
  }

  function loadPositionOverrides() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function savePositionOverride(id, lat, lon) {
    const overrides = loadPositionOverrides();
    overrides[id] = { lat, lon };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }

  function getDeviceById(id) {
    for (const dev of (networkData?.unifi || [])) if (dev.id === id) return { ...dev, source: 'unifi' };
    for (const dev of (networkData?.uisp || [])) if (dev.id === id) return { ...dev, source: 'uisp' };
    return null;
  }

  function getLinkEndpoints(link) {
    const fromDev = getDeviceById(link.from);
    const toDev = getDeviceById(link.to);
    if (!fromDev || !toDev) return null;

    const fromFeature = deviceFeatures.get(link.from);
    const toFeature = deviceFeatures.get(link.to);
    
    const centroid = computeCentroid(networkData?.uisp || []);

    let fromPos, toPos;

    if (fromFeature) {
      const coord = ol.proj.toLonLat(fromFeature.getGeometry().getCoordinates());
      fromPos = { lon: coord[0], lat: coord[1] };
    } else {
      fromPos = resolveDevicePosition(fromDev, fromDev.source, centroid);
    }

    if (toFeature) {
      const coord = ol.proj.toLonLat(toFeature.getGeometry().getCoordinates());
      toPos = { lon: coord[0], lat: coord[1] };
    } else {
      toPos = resolveDevicePosition(toDev, toDev.source, centroid);
    }

    if (!fromPos || !toPos || isNaN(fromPos.lat) || isNaN(fromPos.lon) || isNaN(toPos.lat) || isNaN(toPos.lon)) {
      return null;
    }

    return { from: fromPos, to: toPos };
  }

  function createDeviceStyle(feature, selected) {
    const dev = feature.get('device');
    if (!dev) return null;

    const isOffline = dev.source === 'uisp'
      ? dev.state === 'disconnected'
      : dev.state === 0;

    const type = (dev.type || 'uap').toLowerCase();
    const source = dev.source;

    // Pick fill color
    let fill;
    if (isOffline) {
      fill = PALETTE.offline;
    } else if (source === 'uisp') {
      fill = PALETTE.uisp;
    } else if (type === 'usw') {
      fill = PALETTE.unifi_sw;
    } else if (type === 'ugw' || type === 'udm') {
      fill = PALETTE.unifi_gw;
    } else {
      fill = PALETTE.unifi_ap;
    }

    const strokeColor = selected ? '#ffffff' : (isOffline ? '#374151' : 'rgba(0,0,0,0.45)');
    const strokeWidth = selected ? 2.5 : 1.5;

    // Shape: circle=UniFi AP, square=Switch, triangle=UISP
    let imageStyle;
    if (type === 'usw') {
      imageStyle = new ol.style.RegularShape({
        fill: new ol.style.Fill({ color: fill }),
        stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
        points: 4,
        radius: selected ? 10 : 8,
        angle: Math.PI / 4,
      });
    } else if (source === 'uisp') {
      imageStyle = new ol.style.RegularShape({
        fill: new ol.style.Fill({ color: fill }),
        stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
        points: 3,
        radius: selected ? 12 : 10,
        angle: 0,
      });
    } else if (type === 'ugw' || type === 'udm') {
      // Pentagon for gateway
      imageStyle = new ol.style.RegularShape({
        fill: new ol.style.Fill({ color: fill }),
        stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
        points: 5,
        radius: selected ? 11 : 9,
        angle: -Math.PI / 2,
      });
    } else {
      // Circle for AP
      imageStyle = new ol.style.Circle({
        fill: new ol.style.Fill({ color: fill }),
        stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
        radius: selected ? 9 : 7,
      });
    }

    const styles = [new ol.style.Style({ image: imageStyle })];

    // Glow ring when selected
    if (selected) {
      styles.unshift(
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: 20,
            stroke: new ol.style.Stroke({ color: fill + '55', width: 6 }),
          }),
        }),
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: 14,
            stroke: new ol.style.Stroke({ color: fill + 'aa', width: 3 }),
          }),
        })
      );
    }

    return styles;
  }

  function createClientStyle(feature, selected) {
    const client = feature.get('client');
    const dbm = client?.signal ?? client?.rssi ?? null;
    const isWired = !client?.radio;
    const color = isWired ? PALETTE.client_wired : signalColor(dbm);
    const r = selected ? 6 : 4;

    const styles = [];
    if (selected) {
      styles.push(new ol.style.Style({
        image: new ol.style.Circle({
          radius: r + 7,
          stroke: new ol.style.Stroke({ color: color + '55', width: 4 }),
        }),
      }));
      styles.push(new ol.style.Style({
        image: new ol.style.Circle({
          radius: r + 3,
          stroke: new ol.style.Stroke({ color: color + 'aa', width: 2 }),
        }),
      }));
    }
    styles.push(new ol.style.Style({
      image: new ol.style.Circle({
        radius: r,
        fill: new ol.style.Fill({ color }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.5)', width: 1.5 }),
      }),
    }));
    return styles;
  }

  function createClientLinkStyle() {
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: 'rgba(160,160,180,0.22)',
        width: 1,
        lineDash: [2, 6],
      }),
    });
  }

  function createLinkStyle(feature, selected) {
    const link = feature.get('link');
    const type = link.type || 'wireless';

    let color, width, lineDash;

    if (type === 'wired_unifi') {
      color = selected ? '#7fb3f8' : PALETTE.link_wired + (selected ? '' : 'bb');
      width = selected ? 2.5 : 1.5;
      lineDash = [5, 6];
    } else if (type === 'wireless') {
      // UISP wireless or UniFi wireless – color by signal
      const fromDev = getDeviceById(link.from);
      const isUisp = fromDev?.source === 'uisp' || link.source === 'uisp';
      if (isUisp) {
        color = link.signal != null ? signalColor(link.signal) : PALETTE.link_uisp;
      } else {
        color = link.signal != null ? signalColor(link.signal) : PALETTE.link_wireless;
      }
      width = selected ? signalWidth(link.signal) + 2 : signalWidth(link.signal);
      lineDash = [];
    } else {
      color = '#9aa0a6';
      width = selected ? 3 : 2;
      lineDash = [];
    }

    const styles = [new ol.style.Style({
      stroke: new ol.style.Stroke({ color, width, lineDash }),
    })];

    // Selection highlight — bright outer stroke
    if (selected) {
      styles.unshift(new ol.style.Style({
        stroke: new ol.style.Stroke({ color: color + '44', width: width + 6 }),
      }));
    }

    return styles;
  }

  // === Traffic flow animation — draw in map coords directly on link layer ===

  function makeFlowDotStyle(color, radius, mode = 'play') {
    const strokeColor = mode === 'idle' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.35)';
    const strokeWidth = mode === 'idle' ? 1.2 : 1;
    return new ol.style.Style({
      image: new ol.style.Circle({
        radius,
        fill: new ol.style.Fill({ color }),
        stroke: new ol.style.Stroke({ color: strokeColor, width: strokeWidth }),
      }),
    });
  }

  function drawFlowOnGeometry(vectorContext, geometry, seconds, bytes, color, reverse, mode = 'play') {
    const length = geometry.getLength();
    if (!length || length < 1) return;

    // Log scale: 1 MB (~1e6) -> 0, 100 GB (~1e11) -> 1
    const strength = Math.max(0, Math.min(1, (Math.log10(Math.max(1, bytes)) - 6) / 5));
    if (strength < 0.02) return;

    // Two visual modes:
    // - play: strong flow for timelapse playback
    // - idle: subtle ambient motion when map is static
    const isIdle = mode === 'idle';
    const s = isIdle ? strength * 0.75 : strength;
    const numDots = isIdle
      ? 2 + Math.floor(s * 2)     // 2-4 dots
      : 2 + Math.floor(s * 4);    // 2-6 dots
    const cyclesPerSec = isIdle
      ? 0.07 + s * 0.16           // moderate
      : 0.12 + s * 0.36;          // fast
    const radius = isIdle
      ? 2.2 + s * 1.2             // brighter ambient
      : 2.4 + s * 2.0;            // visible
    const style = makeFlowDotStyle(color, radius, mode);

    vectorContext.setStyle(style);
    for (let i = 0; i < numDots; i++) {
      const progress = (seconds * cyclesPerSec + i / numDots) % 1;
      const frac = reverse ? (1 - progress) : progress;
      const coord = geometry.getCoordinateAt(frac);
      vectorContext.drawGeometry(new ol.geom.Point(coord));
    }
  }

  function startAnimation() {
    linkLayer.on('postrender', function (event) {
      if (!networkData) return;
      const vectorContext = ol.render.getVectorContext(event);
      const seconds = event.frameState.time / 1000;

      linkFeatures.forEach((feature) => {
        const link = feature.get('link');
        const geometry = feature.getGeometry();
        if (!link || !geometry) return;

        const fromDev = getDeviceById(link.from);
        const toDev = getDeviceById(link.to);
        const isWireless = link.type === 'wireless';
        let txBytes = fromDev?.tx_bytes || 0;
        let rxBytes = toDev?.tx_bytes || 0;

        // UISP links often don't provide tx/rx bytes in current payload.
        // Fallback to synthetic intensity based on signal + clients so animation is visible on yellow/green links.
        if (isWireless && txBytes === 0 && rxBytes === 0) {
          const signal = typeof link.signal === 'number' ? link.signal : -65;
          const quality = Math.max(0, Math.min(1, (signal + 90) / 50)); // -90..-40 => 0..1
          const clients = (fromDev?.clients || 0) + (toDev?.clients || 0);
          const clientBoost = Math.log10(clients + 1) * 2.0e9;
          const pseudo = 2.5e8 + quality * 7.5e9 + clientBoost;
          txBytes = pseudo;
          rxBytes = pseudo * 0.85;
        }

        // For wireless links, use link color (green/yellow/red) to match the line.
        const wirelessColor = signalColor(
          typeof link.signal === 'number' ? link.signal : -65
        );
        const txColor = isWireless ? wirelessColor : PALETTE.flow_tx;
        const rxColor = isWireless ? wirelessColor : PALETTE.flow_rx;

        if (timelinePlaying) {
          // Strong dual-direction flow while playback is running.
          if (txBytes > 0) {
            drawFlowOnGeometry(vectorContext, geometry, seconds, txBytes, txColor, false, 'play');
          }
          if (rxBytes > 0) {
            drawFlowOnGeometry(vectorContext, geometry, seconds, rxBytes, rxColor, true, 'play');
          }
        } else {
          // Ambient multi-color flow while static.
          const ambientBytes = txBytes || rxBytes;
          if (ambientBytes > 0) {
            const ambientColors = isWireless
              ? [wirelessColor, '#4ecdc4', '#ffd166']
              : ['#8fa4bd', '#a78bfa'];
            ambientColors.forEach((c, idx) => {
              drawFlowOnGeometry(
                vectorContext,
                geometry,
                seconds + idx * 0.35,
                ambientBytes * (1 - idx * 0.18),
                c,
                idx % 2 === 1,
                'idle'
              );
            });
          }
        }
      });

      // Keep map repainting for both ambient and playback animation.
      event.frameState.animate = true;
    });
  }

  function initMap() {
    streetLayer = new ol.layer.Tile({
      source: new ol.source.OSM(),
      visible: true,
      maxZoom: 22, // Allow scaling tiles beyond their native zoom
    });

    satelliteLayer = new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attributions: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EBP, and the GIS User Community',
        maxZoom: 19, // Esri usually goes up to 19
      }),
      visible: false,
      maxZoom: 22, // Allow OpenLayers to upscale the tiles
    });

    // Слой с дрон-фото (GeoTIFF из OpenDroneMap)
    const DRONE_GEOTIFF_URL = 'odm/odm_orthophoto_reduced.tif';
    const DRONE_EXTENT = [-115.7358263, 33.3457243, -115.7107067, 33.3647887];
    
    try {
      if (typeof ol.source.GeoTIFF !== 'undefined' && typeof ol.layer.WebGLTile !== 'undefined') {
        const droneSource = new ol.source.GeoTIFF({
          sources: [{ url: DRONE_GEOTIFF_URL, normalize: false }],
          wrapX: false,
        });
        // RGB GeoTIFF нужно рендерить через WebGLTile (обычный Tile не поддерживает array data)
        droneLayer = new ol.layer.WebGLTile({
          source: droneSource,
          opacity: 0.85,
          visible: false,
          zIndex: 1,
        });
        droneSource.on('tileloaderror', function () {
          console.warn('⚠ Ошибка загрузки тайла GeoTIFF. Проверьте файл odm/odm_orthophoto_reduced.tif и сервер.');
        });
        console.log('✓ GeoTIFF слой создан (WebGL). Включите слой "Drone Photo" в меню.');
      } else {
        throw new Error('ol.source.GeoTIFF или ol.layer.WebGLTile не определен');
      }
    } catch (error) {
      console.error('❌ Не удалось создать GeoTIFF слой:', error);
      droneLayer = null;
    }

    deviceLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: (feature) => createDeviceStyle(feature, feature === selectedFeature),
      zIndex: 10,
    });

    // Живое обновление линков и клиентов при перетаскивании
    deviceLayer.getSource().on('changefeature', (e) => {
      if (!adminMode) return;
      renderLinks();
      // Перемещаем клиентов вслед за их AP
      const movedDev = e.feature?.get('device');
      if (movedDev) {
        const newCoord = e.feature.getGeometry().getCoordinates();
        clientFeatures.forEach((entry) => {
          if (entry.apId !== movedDev.id) return;
          // Найти индекс этого клиента среди клиентов AP
          const apDev = e.feature.get('device');
          const clients = apDev?.client_list || [];
          const allEntries = [...clientFeatures.values()].filter(en => en.apId === movedDev.id);
          const idx = allEntries.indexOf(entry);
          const total = allEntries.length;
          const newClientCoord = clientRingCoord(newCoord, idx, total);
          entry.dot.getGeometry().setCoordinates(newClientCoord);
          entry.link.getGeometry().setCoordinates([newCoord, newClientCoord]);
        });
      }
    });

    linkLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: (feature) => createLinkStyle(feature, feature === selectedFeature),
      zIndex: 5,
    });

    clientLinkLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: createClientLinkStyle,
      zIndex: 6,
    });

    clientLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: (feature) => createClientStyle(feature, feature === selectedFeature),
      zIndex: 8,
    });

    map = new ol.Map({
      target: 'map',
      layers: [streetLayer, satelliteLayer, droneLayer, linkLayer, clientLinkLayer, clientLayer, deviceLayer].filter(l => l !== null),
      view: new ol.View({
        center: ol.proj.fromLonLat([-115.73, 33.35]),
        zoom: 14,
        maxZoom: 22, // Allow user to zoom in deeper
        constrainResolution: false, // Smooth zooming/scaling
      }),
    });

    startAnimation();

    map.on('click', (e) => {
      map.forEachFeatureAtPixel(e.pixel, (f) => {
        selectFeature(f);
        return true;
      }, { layerFilter: (l) => l === deviceLayer || l === linkLayer || l === clientLayer });
    });

    map.on('pointermove', (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel, { layerFilter: (l) => l === deviceLayer || l === linkLayer || l === clientLayer });
      map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    // Base layer: Streets или Satellite
    document.querySelectorAll('input[name="base-layer"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const layerType = e.target.value;
        streetLayer.setVisible(layerType === 'osm');
        satelliteLayer.setVisible(layerType === 'satellite');
      });
    });

    // Дрон-фото — наложение поверх выбранной базы (спутник или схема)
    document.getElementById('layer-drone-overlay').addEventListener('change', (e) => {
      if (droneLayer) {
        droneLayer.setVisible(e.target.checked);
      } else if (e.target.checked) {
        console.warn('Слой Drone photo не загружен. Откройте в режиме инкогнито или проверьте: сервер запущен из папки проекта, файл odm/odm_orthophoto_reduced.tif существует.');
        e.target.checked = false;
      }
    });

    document.getElementById('layer-uisp').addEventListener('change', (e) => {
      filters.showUisp = e.target.checked;
      renderDevices();
      renderLinks();
    });

    document.getElementById('layer-unifi').addEventListener('change', (e) => {
      filters.showUnifi = e.target.checked;
      renderDevices();
      renderLinks();
    });

    document.getElementById('layer-wireless').addEventListener('change', (e) => {
      filters.showWireless = e.target.checked;
      renderLinks();
    });

    document.getElementById('layer-wired').addEventListener('change', (e) => {
      filters.showWired = e.target.checked;
      renderLinks();
    });

    document.getElementById('layer-clients').addEventListener('change', (e) => {
      filters.showClients = e.target.checked;
      // Re-render all client dots and links
      const clientSource = clientLayer.getSource();
      const clientLinkSource = clientLinkLayer.getSource();
      clientSource.clear();
      clientLinkSource.clear();
      clientFeatures.clear();
      if (filters.showClients) {
        deviceFeatures.forEach((feature, apId) => {
          const dev = feature.get('device');
          if (dev?.client_list?.length) {
            renderClients(apId, feature.getGeometry().getCoordinates());
          }
        });
      }
    });

    document.getElementById('filter-online-only').addEventListener('change', (e) => {
      filters.onlineOnly = e.target.checked;
      renderDevices();
      renderLinks();
    });

    const signalRange = document.getElementById('filter-signal');
    const signalLabel = document.getElementById('signal-value');
    signalRange.addEventListener('input', (e) => {
      filters.minSignal = parseInt(e.target.value, 10);
      signalLabel.textContent = filters.minSignal;
      renderLinks();
    });

    document.getElementById('refresh-btn').addEventListener('click', loadData);
    document.getElementById('admin-mode').addEventListener('change', (e) => {
      adminMode = e.target.checked;
      updateDeviceInteractivity();
    });
    document.getElementById('inspector-close').addEventListener('click', () => {
      selectFeature(null);
    });

    // Device List Toggle
    document.getElementById('toggle-device-list').addEventListener('click', (e) => {
      const container = document.getElementById('device-list-container');
      const btn = e.target;
      container.classList.toggle('hidden');
      btn.classList.toggle('collapsed');
    });

    // Device Search
    document.getElementById('device-search').addEventListener('input', (e) => {
      renderDeviceList(e.target.value);
    });

    // Export Positions
    document.getElementById('export-positions-btn').addEventListener('click', exportPositionLookup);

    // Bottom timeline controls
    bindTimelineUi();
  }

  function selectFeature(feature) {
    selectedFeature = feature;
    deviceLayer.changed();
    linkLayer.changed();
    clientLayer.changed();
    showInspector(feature);
    highlightListItem(feature);
  }

  function highlightListItem(feature) {
    const items = document.querySelectorAll('.device-item');
    items.forEach(item => item.classList.remove('selected'));

    if (feature && feature.get('device')) {
      const dev = feature.get('device');
      const item = document.querySelector(`.device-item[data-id="${dev.id}"]`);
      if (item) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function showInspector(feature) {
    const panel = document.getElementById('inspector');
    const content = document.getElementById('inspector-content');
    const title = document.getElementById('inspector-title');

    if (!feature) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    const dev = feature.get('device');
    const link = feature.get('link');
    const client = feature.get('client');

    if (client) {
      title.textContent = 'Client';
      const isWired = !client.radio;
      const dbm = client.signal ?? client.rssi ?? null;
      const signalDot = dbm != null
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${signalColor(dbm)};margin-right:4px;vertical-align:middle;"></span>`
        : '';

      function fmtBytesC(b) {
        if (b == null) return null;
        if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
        if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
        if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
        return b + ' B';
      }
      function fmtUptimeC(s) {
        if (s == null) return null;
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
      }
      const apFeature = deviceFeatures.get(client.apId);
      const apName = apFeature?.get('device')?.name || client.apId || '-';

      content.innerHTML = `
        <div class="device-thumb">${isWired ? '🔌' : '📶'}</div>
        <dl>
          <dt>Name</dt><dd>${escapeHtml(client.name || client.mac || '?')}</dd>
          <dt>MAC</dt><dd style="font-family:monospace;font-size:0.8rem">${escapeHtml(client.mac || '-')}</dd>
          ${client.ip ? `<dt>IP</dt><dd>${escapeHtml(client.ip)}</dd>` : ''}
          <dt>Connection</dt><dd>${isWired ? '<span class="tag tag-wired">Wired</span>' : `<span class="tag">${escapeHtml(client.radio?.toUpperCase() || 'WiFi')}</span>${client.channel ? ` <span class="tag">ch${client.channel}</span>` : ''}`}</dd>
          ${dbm != null ? `<dt>Signal</dt><dd>${signalDot}${dbm} dBm</dd>` : ''}
          ${client.uptime != null ? `<dt>Uptime</dt><dd>${fmtUptimeC(client.uptime)}</dd>` : ''}
          ${(client.tx_bytes != null || client.rx_bytes != null) ? `<dt>Traffic</dt><dd>↑${fmtBytesC(client.tx_bytes) || '?'} ↓${fmtBytesC(client.rx_bytes) || '?'}</dd>` : ''}
          <dt>Access Point</dt><dd>${escapeHtml(apName)}</dd>
        </dl>
      `;
      return;
    }

    if (dev) {
      title.textContent = 'Device';
      const imgUrl = MODEL_IMAGES[dev.model];
      const thumbHtml = imgUrl
        ? `<div class="device-thumb"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(dev.model || '')}" onerror="this.parentElement.innerHTML='📡'"></div>`
        : `<div class="device-thumb">📡</div>`;

      const isOnline = dev.source === 'uisp' ? dev.state === 'active' : dev.state === 1;
      const stateLabel = dev.source === 'uisp' ? dev.state : (dev.state === 1 ? 'Online' : 'Offline');

      function fmtBytes(b) {
        if (b == null) return null;
        if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
        if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
        if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
        return b + ' B';
      }
      function fmtUptime(s) {
        if (s == null) return null;
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '<1m';
      }

      const clients = dev.client_list || [];
      // client_list присутствует только у UniFi-устройств; UISP — только счётчик RF-клиентов
      const hasClientData = Array.isArray(dev.client_list);
      const clientsHtml = clients.length > 0 ? `
        <div class="clients-section">
          <div class="clients-header">Clients (${clients.length})</div>
          <ul class="client-list">
            ${clients.map(c => `
              <li class="client-item">
                <div class="client-name">${escapeHtml(c.name || c.mac || '?')}</div>
                <div class="client-meta">
                  ${c.ip ? `<span class="tag">${escapeHtml(c.ip)}</span>` : ''}
                  ${c.radio ? `<span class="tag">${escapeHtml(c.radio.toUpperCase())}</span>` : '<span class="tag tag-wired">Wired</span>'}
                  ${c.channel ? `<span class="tag">ch${c.channel}</span>` : ''}
                  ${c.signal != null ? `<span class="tag tag-signal">${c.signal} dBm</span>` : c.rssi != null ? `<span class="tag tag-signal">RSSI ${c.rssi}</span>` : ''}
                  ${c.uptime != null ? `<span class="tag">${fmtUptime(c.uptime)}</span>` : ''}
                </div>
                ${(c.tx_bytes != null || c.rx_bytes != null) ? `<div class="client-traffic">↑${fmtBytes(c.tx_bytes) || '?'} ↓${fmtBytes(c.rx_bytes) || '?'}</div>` : ''}
              </li>
            `).join('')}
          </ul>
        </div>
      ` : (hasClientData && dev.clients > 0 ? `<div class="clients-section"><div class="clients-header">Clients (${dev.clients})</div><p class="clients-hint">Run script to load details</p></div>` : '');

      content.innerHTML = `
        ${thumbHtml}
        <dl>
          <dt>Name</dt><dd>${escapeHtml(dev.name || '-')}</dd>
          <dt>Model</dt><dd>${escapeHtml(dev.model || '-')}</dd>
          <dt>Type</dt><dd>${dev.type || '-'}</dd>
          <dt>State</dt><dd class="${isOnline ? 'state-online' : 'state-offline'}">${stateLabel}</dd>
          ${dev.ip ? `<dt>IP</dt><dd>${escapeHtml(dev.ip)}</dd>` : ''}
          ${dev.version ? `<dt>Firmware</dt><dd>${escapeHtml(dev.version)}</dd>` : ''}
          ${dev.uptime != null ? `<dt>Uptime</dt><dd>${fmtUptime(dev.uptime)}</dd>` : ''}
          ${(dev.tx_bytes != null || dev.rx_bytes != null) ? `<dt>Traffic</dt><dd>↑${fmtBytes(dev.tx_bytes) || '?'} ↓${fmtBytes(dev.rx_bytes) || '?'}</dd>` : ''}
          ${dev.clients != null ? `<dt>Clients</dt><dd>${dev.clients}</dd>` : ''}
          <dt>Coordinates</dt><dd>${(dev.lat != null && dev.lon != null) ? `${dev.lat.toFixed(5)}, ${dev.lon.toFixed(5)}` : '-'}</dd>
        </dl>
        ${clientsHtml}
      `;
    } else if (link) {
      title.textContent = 'Link';
      const fromDev = getDeviceById(link.from);
      const toDev = getDeviceById(link.to);
      content.innerHTML = `
        <dl>
          <dt>From</dt><dd>${escapeHtml(fromDev?.name || link.from)}</dd>
          <dt>To</dt><dd>${escapeHtml(toDev?.name || link.to)}</dd>
          <dt>Type</dt><dd>${link.type || '-'}</dd>
          <dt>State</dt><dd>${link.state || '-'}</dd>
          ${link.signal != null ? `<dt>Signal</dt><dd>${link.signal} dBm</dd>` : ''}
        </dl>
      `;
    }
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // Place clients in a deterministic ring around their AP/switch
  function clientRingCoord(apProjCoord, index, total) {
    const angle = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = 22 + (total > 8 ? 8 : 0); // slightly larger ring for crowded APs
    return [
      apProjCoord[0] + Math.cos(angle) * radius,
      apProjCoord[1] + Math.sin(angle) * radius,
    ];
  }

  function renderClients(apId, apProjCoord) {
    const clientSource = clientLayer.getSource();
    const clientLinkSource = clientLinkLayer.getSource();

    // Remove old features for this AP
    const toRemove = [];
    clientFeatures.forEach((entry, mac) => {
      if (entry.apId === apId) toRemove.push(mac);
    });
    toRemove.forEach((mac) => {
      const entry = clientFeatures.get(mac);
      if (entry.dot) clientSource.removeFeature(entry.dot);
      if (entry.link) clientLinkSource.removeFeature(entry.link);
      clientFeatures.delete(mac);
    });

    if (!filters.showClients) return;

    const apFeature = deviceFeatures.get(apId);
    if (!apFeature) return;
    const dev = apFeature.get('device');
    const listedClients = Array.isArray(dev?.client_list) ? dev.client_list : [];
    const count = Math.max(0, parseInt(dev?.clients || 0, 10));
    if (count === 0 && listedClients.length === 0) return;
    const renderCount = Math.max(count, listedClients.length);

    for (let i = 0; i < renderCount; i++) {
      const client = listedClients[i] || { mac: `${apId}-hist-${i}`, name: `Client ${i + 1}` };
      const coord = clientRingCoord(apProjCoord, i, renderCount);

      const dot = new ol.Feature({ geometry: new ol.geom.Point(coord) });
      dot.set('client', { ...client, apId });
      clientSource.addFeature(dot);

      const linkFeat = new ol.Feature({
        geometry: new ol.geom.LineString([apProjCoord, coord]),
      });
      linkFeat.set('clientLink', true);
      clientLinkSource.addFeature(linkFeat);

      clientFeatures.set(client.mac || `${apId}-${i}`, { dot, link: linkFeat, apId });
    }
  }

  function renderDevices() {
    const centroid = computeCentroid(networkData?.uisp || []);
    const deviceSource = deviceLayer.getSource();
    const clientSource = clientLayer.getSource();
    const clientLinkSource = clientLinkLayer.getSource();
    deviceSource.clear();
    clientSource.clear();
    clientLinkSource.clear();
    deviceFeatures.clear();
    clientFeatures.clear();

    if (filters.showUnifi) {
      for (const dev of networkData?.unifi || []) {
        const isOffline = dev.state === 0;
        if (filters.onlineOnly && isOffline) continue;

        const pos = resolveDevicePosition(dev, 'unifi', centroid);
        if (!pos) continue;

        // Add a small fixed jitter based on ID if the device is at the exact centroid
        let lon = pos.lon;
        let lat = pos.lat;
        const isAtCentroid = centroid && 
                             Math.abs(pos.lat - centroid.lat) < 0.000001 && 
                             Math.abs(pos.lon - centroid.lon) < 0.000001;

        if (isAtCentroid) {
          // Use a deterministic jitter based on MAC address/ID so it doesn't jump around
          const hash = (dev.id || '').split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
          }, 0);
          const angle = Math.abs(hash % 360) * (Math.PI / 180);
          const dist = 0.0004 + (Math.abs(hash % 100) / 20000); // 40-90 meters spread
          lon += Math.cos(angle) * dist;
          lat += Math.sin(angle) * dist;
        }

        const feature = new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
        });
        feature.set('device', { ...dev, source: 'unifi', lat: lat, lon: lon });
        deviceSource.addFeature(feature);
        deviceFeatures.set(dev.id, feature);

        // Render real client dots + links
        if (!isOffline) {
          renderClients(dev.id, ol.proj.fromLonLat([lon, lat]));
        }
      }
    }

    if (filters.showUisp) {
      for (const dev of networkData?.uisp || []) {
        const isOffline = dev.state === 'disconnected';
        if (filters.onlineOnly && isOffline) continue;

        const pos = resolveDevicePosition(dev, 'uisp', centroid);
        if (!pos) continue;
        const feature = new ol.Feature({
          geometry: new ol.geom.Point(ol.proj.fromLonLat([pos.lon, pos.lat])),
        });
        feature.set('device', { ...dev, source: 'uisp', lat: pos.lat, lon: pos.lon });
        deviceSource.addFeature(feature);
        deviceFeatures.set(dev.id, feature);

        if (!isOffline) {
          renderClients(dev.id, ol.proj.fromLonLat([pos.lon, pos.lat]));
        }
      }
    }
    renderDeviceList();
  }

  function renderDeviceList(searchQuery = '') {
    const list = document.getElementById('device-list');
    list.innerHTML = '';

    const query = searchQuery.toLowerCase();
    const allDevices = [];
    
    deviceFeatures.forEach((feature) => {
      const dev = feature.get('device');
      if (!dev) return;
      if (query && !dev.name.toLowerCase().includes(query) && !dev.model.toLowerCase().includes(query) && !dev.id.toLowerCase().includes(query)) return;
      allDevices.push({ dev, feature });
    });

    allDevices.sort((a, b) => (a.dev.name || '').localeCompare(b.dev.name || ''));

    allDevices.forEach(({ dev, feature }) => {
      const item = document.createElement('div');
      item.className = 'device-item';
      if (selectedFeature === feature) item.classList.add('selected');
      item.dataset.id = dev.id;

      const isOffline = dev.source === 'uisp' ? (dev.state === 'disconnected') : (dev.state === 0);
      
      item.innerHTML = `
        <span class="device-name" title="${escapeHtml(dev.name)} [${dev.model}]">${escapeHtml(dev.name)}</span>
        <span class="device-status ${isOffline ? 'offline' : 'online'}"></span>
      `;

      item.addEventListener('click', () => {
        selectFeature(feature);
        const geom = feature.getGeometry();
        map.getView().animate({
          center: geom.getCoordinates(),
          zoom: 18,
          duration: 500
        });
      });

      list.appendChild(item);
    });
  }

  function isUnifiId(id) {
    return typeof id === 'string' && id.includes(':');
  }
  function isUispId(id) {
    return typeof id === 'string' && id.includes('-') && id.length >= 32;
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPositionLookup() {
    const overrides = loadPositionOverrides();
    const unifiOut = { "_comment": "UniFi device positions (MAC = key). Replace unifi_position_lookup.json." };
    const uispOut = { "_comment": "UISP device positions (device UUID = key). Replace uisp_position_lookup.json." };

    for (const [id, pos] of Object.entries(overrides)) {
      const dev = getDeviceById(id);
      const entry = { lat: pos.lat, lon: pos.lon };
      if (isUnifiId(id)) {
        unifiOut[id] = { name: dev?.name || `Device ${id}`, ...entry };
      } else if (isUispId(id)) {
        uispOut[id] = { name: dev?.name || id, ...entry };
      }
    }

    if (Object.keys(unifiOut).length > 1) downloadJson('unifi_position_lookup.json', unifiOut);
    if (Object.keys(uispOut).length > 1) downloadJson('uisp_position_lookup.json', uispOut);

    const parts = [];
    if (Object.keys(unifiOut).length > 1) parts.push('unifi_position_lookup.json');
    if (Object.keys(uispOut).length > 1) parts.push('uisp_position_lookup.json');
    alert(parts.length
      ? 'Экспорт: ' + parts.join(', ') + '. Положите файлы в папку проекта и запустите: python network_collector.py'
      : 'Нет сохранённых позиций. Включите Admin, перетащите устройства и нажмите Export снова.');
  }

  function renderLinks() {
    const linkSource = linkLayer.getSource();
    linkSource.clear();
    linkFeatures.clear();

    for (const link of networkData?.links || []) {
      const isWireless = link.type === 'wireless';
      const isWired = link.type === 'wired_unifi';
      
      if (isWireless && !filters.showWireless) continue;
      if (isWired && !filters.showWired) continue;
      if (isWireless && link.signal != null && link.signal < filters.minSignal) continue;
      
      const fromDev = getDeviceById(link.from);
      const toDev = getDeviceById(link.to);
      if (filters.onlineOnly) {
        const fromOffline = fromDev?.source === 'uisp' ? fromDev.state === 'disconnected' : fromDev?.state === 0;
        const toOffline = toDev?.source === 'uisp' ? toDev.state === 'disconnected' : toDev?.state === 0;
        if (fromOffline || toOffline) continue;
      }

      const ep = getLinkEndpoints(link);
      if (!ep) continue;
      const line = new ol.geom.LineString([
        ol.proj.fromLonLat([ep.from.lon, ep.from.lat]),
        ol.proj.fromLonLat([ep.to.lon, ep.to.lat]),
      ]);
      const feature = new ol.Feature({ geometry: line });
      feature.set('link', link);
      linkSource.addFeature(feature);
      linkFeatures.set(`${link.from}-${link.to}`, feature);
    }
  }

  let modifyInteraction = null;

  function updateDeviceInteractivity() {
    if (modifyInteraction) {
      map.removeInteraction(modifyInteraction);
      modifyInteraction = null;
    }
    if (!adminMode) return;

    modifyInteraction = new ol.interaction.Modify({
      source: deviceLayer.getSource(),
      filter: (f) => !!f.get('device'),
    });
    map.addInteraction(modifyInteraction);

    modifyInteraction.on('modifyend', (e) => {
      e.features.forEach((f) => {
        const dev = f.get('device');
        if (!dev) return;
        const coord = f.getGeometry().getCoordinates();
        const lonlat = ol.proj.toLonLat(coord);
        savePositionOverride(dev.id, lonlat[1], lonlat[0]);
        dev.lat = lonlat[1];
        dev.lon = lonlat[0];
        renderLinks();
      });
    });
  }

  function fitMapToData() {
    const meta = networkData?.map_metadata;
    if (meta?.lat_min != null && meta?.lat_max != null && meta?.lon_min != null && meta?.lon_max != null) {
      map.getView().fit(
        ol.proj.transformExtent([meta.lon_min, meta.lat_min, meta.lon_max, meta.lat_max], 'EPSG:4326', 'EPSG:3857'),
        { padding: [40, 40, 40, 40], maxZoom: 16 }
      );
    }
  }

  function stopTimelinePlayback() {
    timelinePlaying = false;
    if (timelineTimer) {
      clearInterval(timelineTimer);
      timelineTimer = null;
    }
    const playBtn = document.getElementById('timeline-play');
    if (playBtn) playBtn.textContent = '▶';
    // Force one static redraw so animated dots disappear immediately.
    if (map) map.render();
  }

  function updateTimelineHours() {
    const el = document.querySelector('.timeline-hours');
    if (!el) return;
    const labels = timelineRange === '30d'
      ? ['-30d', '-24d', '-18d', '-12d', '-9d', '-6d', '-3d', 'now']
      : timelineRange === '7d'
      ? ['-7d', '-6d', '-5d', '-4d', '-3d', '-2d', '-1d', 'now']
      : ['7p', '8p', '9p', '10p', '11p', '12a', '1a', '2a'];
    const spans = Array.from(el.querySelectorAll('span'));
    for (let i = 0; i < Math.min(spans.length, labels.length); i++) {
      spans[i].textContent = labels[i];
    }
  }

  function updateTimelineLabel(ts) {
    const label = document.getElementById('timeline-ts');
    if (!label) return;
    if (!ts) {
      label.textContent = 'Live';
      return;
    }
    const dt = new Date(ts);
    if (isNaN(dt.getTime())) {
      label.textContent = ts;
      return;
    }
    const day = dt.toLocaleDateString(undefined, { weekday: 'short' });
    const hm = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
    label.textContent = `${day} ${hm}`;
  }

  function applyTimelineFrame(idx) {
    if (!baseNetworkData || timelineFrames.length === 0) return;
    const frame = timelineFrames[idx];
    if (!frame) return;

    timelineFrameIdx = idx;
    const slider = document.getElementById('timeline-slider');
    if (slider) slider.value = String(idx);
    updateTimelineLabel(frame.ts);

    // Start from latest topology/coords, then overlay state metrics from frame
    networkData = deepClone(baseNetworkData);
    const devMap = new Map((frame.devices || []).map((d) => [d.id, d]));
    const frameLinkMap = new Map((frame.links || []).map((l) => [linkKey(l), l]));

    for (const dev of (networkData.unifi || [])) {
      const item = devMap.get(dev.id);
      if (!item) continue;
      if (item.state != null) dev.state = item.state;
      if (item.clients != null) dev.clients = item.clients;
      if (item.tx_bytes != null) dev.tx_bytes = item.tx_bytes;
      if (item.rx_bytes != null) dev.rx_bytes = item.rx_bytes;
    }
    for (const dev of (networkData.uisp || [])) {
      const item = devMap.get(dev.id);
      if (!item) continue;
      if (item.state != null) dev.state = item.state;
      if (item.clients != null) dev.clients = item.clients;
      if (item.tx_bytes != null) dev.tx_bytes = item.tx_bytes;
      if (item.rx_bytes != null) dev.rx_bytes = item.rx_bytes;
    }
    for (const link of (networkData.links || [])) {
      const item = frameLinkMap.get(linkKey(link));
      if (!item) continue;
      if (item.signal != null) link.signal = item.signal;
      if (item.state != null) link.state = item.state;
    }

    renderDevices();
    renderLinks();
  }

  function startTimelinePlayback() {
    if (timelineFrames.length < 2) return;
    stopTimelinePlayback();
    timelinePlaying = true;
    const playBtn = document.getElementById('timeline-play');
    const speedEl = document.getElementById('timeline-speed');
    if (playBtn) playBtn.textContent = '❚❚';

    const tick = () => {
      const speed = Math.max(1, parseInt(speedEl?.value || '1', 10));
      const nextIdx = (timelineFrameIdx + speed) % timelineFrames.length;
      applyTimelineFrame(nextIdx);
    };
    timelineTimer = setInterval(tick, 700);
    // Trigger animation loop on link postrender.
    if (map) map.render();
  }

  function bindTimelineUi() {
    const playBtn = document.getElementById('timeline-play');
    const slider = document.getElementById('timeline-slider');
    const speedEl = document.getElementById('timeline-speed');
    const rangeEl = document.getElementById('timeline-range');

    if (!playBtn || !slider || !speedEl || !rangeEl) return;
    updateTimelineHours();

    playBtn.addEventListener('click', () => {
      if (!timelineFrames.length) return;
      if (timelinePlaying) {
        stopTimelinePlayback();
      } else {
        startTimelinePlayback();
      }
    });

    slider.addEventListener('input', (e) => {
      stopTimelinePlayback();
      const idx = parseInt(e.target.value, 10) || 0;
      applyTimelineFrame(idx);
    });

    speedEl.addEventListener('change', () => {
      if (!timelinePlaying) return;
      startTimelinePlayback();
    });

    rangeEl.addEventListener('change', (e) => {
      timelineRange = e.target.value;
      stopTimelinePlayback();
      updateTimelineHours();
      loadTimeline();
    });
  }

  function loadTimeline() {
    const url = TIMELINE_URLS[timelineRange] || TIMELINE_URLS['24h'];
    return fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((timeline) => {
        timelineFrames = timeline?.frames || [];
        const slider = document.getElementById('timeline-slider');
        if (slider) {
          slider.max = String(Math.max(0, timelineFrames.length - 1));
          slider.value = '0';
          slider.disabled = timelineFrames.length === 0;
        }
        const playBtn = document.getElementById('timeline-play');
        if (playBtn) playBtn.disabled = timelineFrames.length < 2;
        if (timelineFrames.length > 0) {
          applyTimelineFrame(0);
          if (timelineFrames.length < 2) {
            const label = document.getElementById('timeline-ts');
            if (label) label.textContent = 'Need more samples';
          }
        } else {
          updateTimelineLabel(null);
        }
      })
      .catch((err) => {
        timelineFrames = [];
        updateTimelineLabel(null);
        const slider = document.getElementById('timeline-slider');
        if (slider) slider.disabled = true;
        const playBtn = document.getElementById('timeline-play');
        if (playBtn) playBtn.disabled = true;
        console.warn('Timeline not available yet:', err.message);
      });
  }

  function loadData() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Loading…';

    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        networkData = data;
        baseNetworkData = deepClone(data);
        stopTimelinePlayback();
        renderDevices();
        renderLinks();
        fitMapToData();
        selectFeature(null);
        return loadTimeline();
      })
      .catch((err) => {
        console.error('Failed to load network data:', err);
        alert('Could not load network_data.json. Run the collector first or check the file path.');
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'Refresh';
      });
  }

  function run() {
    initMap();
    loadData();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
