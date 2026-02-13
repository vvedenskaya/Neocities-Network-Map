/**
 * Bombay Mars LAN Map - Sprint 1
 * Interactive map of Mars College / Bombay Beach Neocities network.
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'bombay-mars-device-positions';
  const DATA_URL = 'network_data.json';

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
  let streetLayer;
  let satelliteLayer;
  let droneLayer = null;
  let networkData = null;
  let deviceFeatures = new Map();
  let linkFeatures = new Map();
  let selectedFeature = null;
  let adminMode = false;

  const filters = {
    showUisp: true,
    showUnifi: true,
    showWireless: true,
    showWired: true,
    onlineOnly: false,
    minSignal: -90
  };

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
      ? (dev.state === 'disconnected')
      : (dev.state === 0);
    const type = dev.type || 'uap';
    let fill = selected ? '#4ecdc4' : (isOffline ? '#5f6368' : '#4ecdc4');
    let stroke = selected ? '#fff' : (isOffline ? '#3c4043' : '#3ba89f');
    let radius = 6;
    let shape = 'circle';

    if (type === 'usw') {
      radius = 7;
      shape = 'square';
    } else if (type === 'airMax') {
      radius = 8;
      shape = 'triangle';
    }

    const mainStyle = new ol.style.Style({
      image: shape === 'square'
        ? new ol.style.RegularShape({
            fill: new ol.style.Fill({ color: fill }),
            stroke: new ol.style.Stroke({ color: stroke, width: 2 }),
            points: 4,
            angle: Math.PI / 4,
            radius: radius,
          })
        : shape === 'triangle'
        ? new ol.style.RegularShape({
            fill: new ol.style.Fill({ color: fill }),
            stroke: new ol.style.Stroke({ color: stroke, width: 2 }),
            points: 3,
            angle: 0,
            radius: radius,
          })
        : new ol.style.Circle({
            fill: new ol.style.Fill({ color: fill }),
            stroke: new ol.style.Stroke({ color: stroke, width: 2 }),
            radius: radius,
          }),
    });

    if (selected) {
      return [
        new ol.style.Style({
          image: new ol.style.Circle({
            radius: radius + 8,
            stroke: new ol.style.Stroke({
              color: 'rgba(78, 205, 196, 0.8)',
              width: 3,
            }),
          }),
        }),
        mainStyle
      ];
    }
    return mainStyle;
  }

  function createLinkStyle(feature, selected) {
    const link = feature.get('link');
    const color = link.type === 'wireless' && link.signal != null
      ? signalColor(link.signal)
      : '#9aa0a6';
    const width = link.type === 'wireless' && link.signal != null
      ? signalWidth(link.signal)
      : 2;
    const opacity = selected ? 1 : 0.85;

    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: color,
        width: selected ? width + 2 : width,
        lineDash: link.type === 'wired_unifi' ? [4, 4] : [],
      }),
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

    // Добавляем «живое» обновление линков при перетаскивании
    deviceLayer.getSource().on('changefeature', () => {
      if (adminMode) renderLinks();
    });

    linkLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: (feature) => createLinkStyle(feature, feature === selectedFeature),
      zIndex: 5,
    });

    clientLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 2,
          fill: new ol.style.Fill({ color: '#ffffff' }),
          stroke: new ol.style.Stroke({ color: '#4ecdc4', width: 1 }),
        }),
      }),
      zIndex: 8,
    });

    map = new ol.Map({
      target: 'map',
      layers: [streetLayer, satelliteLayer, droneLayer, linkLayer, clientLayer, deviceLayer].filter(l => l !== null),
      view: new ol.View({
        center: ol.proj.fromLonLat([-115.73, 33.35]),
        zoom: 14,
        maxZoom: 22, // Allow user to zoom in deeper
        constrainResolution: false, // Smooth zooming/scaling
      }),
    });

    map.on('click', (e) => {
      map.forEachFeatureAtPixel(e.pixel, (f) => {
        selectFeature(f);
        return true;
      }, { layerFilter: (l) => l === deviceLayer || l === linkLayer });
    });

    map.on('pointermove', (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel, { layerFilter: (l) => l === deviceLayer || l === linkLayer });
      map.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    // Layer & Filter Listeners
    document.querySelectorAll('input[name="base-layer"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const layerType = e.target.value;
        streetLayer.setVisible(layerType === 'osm');
        satelliteLayer.setVisible(layerType === 'satellite');
        if (droneLayer) {
          droneLayer.setVisible(layerType === 'drone');
        }
      });
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
  }

  function selectFeature(feature) {
    selectedFeature = feature;
    deviceLayer.changed();
    linkLayer.changed();
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

    if (dev) {
      title.textContent = 'Device';
      const imgUrl = MODEL_IMAGES[dev.model];
      const thumbHtml = imgUrl
        ? `<div class="device-thumb"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(dev.model || '')}" onerror="this.parentElement.innerHTML='📡'"></div>`
        : `<div class="device-thumb">📡</div>`;
      content.innerHTML = `
        ${thumbHtml}
        <dl>
          <dt>Name</dt><dd>${escapeHtml(dev.name || '-')}</dd>
          <dt>Model</dt><dd>${escapeHtml(dev.model || '-')}</dd>
          <dt>Type</dt><dd>${dev.type || '-'}</dd>
          <dt>State</dt><dd class="${dev.source === 'uisp' ? (dev.state === 'active' ? 'state-online' : 'state-offline') : (dev.state === 1 ? 'state-online' : 'state-offline')}">${dev.source === 'uisp' ? dev.state : (dev.state === 1 ? 'Online' : 'Offline')}</dd>
          ${dev.clients != null ? `<dt>Clients</dt><dd>${dev.clients}</dd>` : ''}
          <dt>Coordinates</dt><dd>${(dev.lat != null && dev.lon != null) ? `${dev.lat.toFixed(5)}, ${dev.lon.toFixed(5)}` : '-'}</dd>
        </dl>
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

  function renderDevices() {
    const centroid = computeCentroid(networkData?.uisp || []);
    const deviceSource = deviceLayer.getSource();
    const clientSource = clientLayer.getSource();
    deviceSource.clear();
    clientSource.clear();
    deviceFeatures.clear();

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

        // Render client swarm
        if (!isOffline && dev.clients > 0) {
          const deviceProjCoord = ol.proj.fromLonLat([lon, lat]);
          for (let i = 0; i < dev.clients; i++) {
            // Random orbit around device
            const angle = Math.random() * Math.PI * 2;
            const distance = 10 + Math.random() * 15; // 10-25 meters/units offset
            const clientCoord = [
              deviceProjCoord[0] + Math.cos(angle) * distance,
              deviceProjCoord[1] + Math.sin(angle) * distance
            ];
            const clientFeature = new ol.Feature({
              geometry: new ol.geom.Point(clientCoord)
            });
            clientSource.addFeature(clientFeature);
          }
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

        // Render client swarm for UISP
        if (!isOffline && dev.clients > 0) {
          const deviceProjCoord = ol.proj.fromLonLat([pos.lon, pos.lat]);
          for (let i = 0; i < dev.clients; i++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = 12 + Math.random() * 18;
            const clientCoord = [
              deviceProjCoord[0] + Math.cos(angle) * distance,
              deviceProjCoord[1] + Math.sin(angle) * distance
            ];
            const clientFeature = new ol.Feature({
              geometry: new ol.geom.Point(clientCoord)
            });
            clientSource.addFeature(clientFeature);
          }
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

  function exportPositionLookup() {
    const overrides = loadPositionOverrides();
    const comment = "Manually measured lat/lon for UniFi access points. Add entries as you measure devices. MAC address (id) is the key. Include name for human readability.";
    const output = {
      "_comment": comment
    };

    // Merge current overrides with existing data names if possible
    for (const [id, pos] of Object.entries(overrides)) {
      const dev = getDeviceById(id);
      output[id] = {
        name: dev?.name || `Device ${id}`,
        lat: pos.lat,
        lon: pos.lon
      };
    }

    const json = JSON.stringify(output, null, 2);
    
    // Create a blob and download it
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unifi_position_lookup.json';
    a.click();
    URL.revokeObjectURL(url);
    
    alert('Positions exported! Replace unifi_position_lookup.json with this file to persist changes.');
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
        renderDevices();
        renderLinks();
        fitMapToData();
        selectFeature(null);
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
