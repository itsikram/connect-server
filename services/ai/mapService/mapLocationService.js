/**
 * Map Location Service
 * Generates map data and HTML for Leaflet map displays
 */

/**
 * Generate Leaflet map markers from friends data
 * @param {array} friends - Friends with location data
 * @param {object} userLocation - User's current location {latitude, longitude}
 * @param {string} lang - Language code
 * @returns {object} - Markers and map config
 */
function generateMapMarkers(friends, userLocation, lang = 'eng') {
  const markers = [];

  // Add user marker
  markers.push({
    id: 'user',
    type: 'user',
    latitude: userLocation.latitude,
    longitude: userLocation.longitude,
    title: lang === 'bn' ? 'আপনার অবস্থান' : 'Your Location',
    icon: 'user',
    color: '#0066CC',
    zIndex: 1000
  });

  // Add friend markers
  friends.forEach((friend, index) => {
    if (friend.distance === null) return; // Skip friends without location

    markers.push({
      id: friend.id,
      type: 'friend',
      latitude: friend.lastLocation.latitude,
      longitude: friend.lastLocation.longitude,
      title: friend.name,
      username: friend.username,
      distance: friend.distance,
      direction: friend.direction,
      address: friend.address,
      profilePic: friend.profilePic,
      icon: getIconForDistance(friend.distance),
      color: getColorForDistance(friend.distance),
      emoji: getEmojiForDistance(friend.distance),
      zIndex: 999 - index
    });
  });

  return markers;
}

/**
 * Get icon type based on distance
 */
function getIconForDistance(distance) {
  if (distance < 0.5) return 'red-marker';
  if (distance < 2) return 'orange-marker';
  if (distance < 10) return 'yellow-marker';
  if (distance < 50) return 'green-marker';
  return 'blue-marker';
}

/**
 * Get color based on distance
 */
function getColorForDistance(distance) {
  if (distance < 0.5) return '#FF0000'; // Very close - Red
  if (distance < 2) return '#FF6600'; // Close - Orange
  if (distance < 10) return '#FFCC00'; // Nearby - Yellow
  if (distance < 50) return '#00CC00'; // Moderate - Green
  return '#0066FF'; // Far - Blue
}

/**
 * Get emoji based on distance
 */
function getEmojiForDistance(distance) {
  if (distance < 0.5) return '🔴';
  if (distance < 2) return '🟠';
  if (distance < 10) return '🟡';
  if (distance < 50) return '🟢';
  return '🔵';
}

/**
 * Calculate map bounds from markers
 * @param {array} markers - Markers array
 * @returns {object} - Bounds {north, south, east, west}
 */
function calculateMapBounds(markers) {
  if (markers.length === 0) {
    return { north: 0, south: 0, east: 0, west: 0 };
  }

  let north = markers[0].latitude;
  let south = markers[0].latitude;
  let east = markers[0].longitude;
  let west = markers[0].longitude;

  markers.forEach(marker => {
    if (marker.latitude > north) north = marker.latitude;
    if (marker.latitude < south) south = marker.latitude;
    if (marker.longitude > east) east = marker.longitude;
    if (marker.longitude < west) west = marker.longitude;
  });

  // Add padding (5% of bounds)
  const latPadding = (north - south) * 0.1;
  const lonPadding = (east - west) * 0.1;

  return {
    north: north + latPadding,
    south: south - latPadding,
    east: east + lonPadding,
    west: west - lonPadding,
    center: {
      latitude: (north + south) / 2,
      longitude: (east + west) / 2
    }
  };
}

/**
 * Generate map HTML for embedding
 * @param {array} markers - Markers data
 * @param {object} bounds - Map bounds
 * @param {string} mapId - Unique map ID
 * @param {string} lang - Language code
 * @returns {string} - HTML for map
 */
function generateMapHTML(markers, bounds, mapId = 'friendsMap', lang = 'eng') {
  const html = `
    <div id="${mapId}" style="width: 100%; height: 500px; border-radius: 8px; margin: 20px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"></div>

    <script>
      (function() {
        const mapData = ${JSON.stringify({ markers, bounds, lang })};

        // Initialize map
        const map = L.map('${mapId}').setView(
          [${bounds.center.latitude}, ${bounds.center.longitude}],
          13
        );

        // Add tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
          maxZoom: 19
        }).addTo(map);

        // Add markers
        mapData.markers.forEach(marker => {
          let icon = createMarkerIcon(marker);
          let popup = createPopupContent(marker, mapData.lang);

          L.marker([marker.latitude, marker.longitude], { icon: icon })
            .bindPopup(popup)
            .addTo(map);
        });

        // Fit bounds
        const bounds = L.latLngBounds(
          [${bounds.south}, ${bounds.west}],
          [${bounds.north}, ${bounds.east}]
        );
        map.fitBounds(bounds, { padding: [50, 50] });
      })();

      function createMarkerIcon(marker) {
        let html;
        if (marker.type === 'user') {
          html = '📍';
        } else {
          html = marker.emoji || '📍';
        }

        return L.divIcon({
          html: html,
          className: 'custom-marker',
          iconSize: [40, 40],
          iconAnchor: [20, 40],
          popupAnchor: [0, -40]
        });
      }

      function createPopupContent(marker, lang) {
        if (marker.type === 'user') {
          return lang === 'bn'
            ? '<div style="text-align: center; padding: 10px;"><strong>আপনার অবস্থান</strong></div>'
            : '<div style="text-align: center; padding: 10px;"><strong>Your Location</strong></div>';
        }

        const distance = marker.distance ? marker.distance.toFixed(2) : '?';
        const distanceText = lang === 'bn' ? 'কিমি দূরে' : 'km away';
        const directionText = marker.direction || '';
        const address = marker.address ? (lang === 'bn' ? 'ঠিকানা: ' : 'Address: ') + marker.address : '';

        return \`
          <div style="padding: 10px; text-align: center; min-width: 200px;">
            <strong>\${marker.title}</strong>
            <div style="font-size: 12px; margin: 5px 0;">\${distance} \${distanceText}</div>
            \${directionText ? '<div style="font-size: 12px;">' + directionText + '</div>' : ''}
            \${address ? '<div style="font-size: 12px;">' + address + '</div>' : ''}
          </div>
        \`;
      }
    </script>
  `;

  return html;
}

/**
 * Generate map data object for API response
 * @param {array} friends - Friends with location
 * @param {object} userLocation - User location
 * @param {string} lang - Language
 * @returns {object} - Map data for response
 */
function generateMapData(friends, userLocation, lang = 'eng') {
  const nearbyfriends = friends.filter(f => f.distance !== null);
  const markers = generateMapMarkers(nearbyfriends, userLocation, lang);
  const bounds = calculateMapBounds(markers);

  return {
    markers: markers,
    bounds: bounds,
    center: bounds.center,
    zoom: calculateOptimalZoom(bounds),
    totalMarkers: markers.length,
    userLocation: userLocation
  };
}

/**
 * Calculate optimal zoom level based on bounds
 * @param {object} bounds - Map bounds
 * @returns {number} - Zoom level
 */
function calculateOptimalZoom(bounds) {
  const latDiff = bounds.north - bounds.south;
  const lonDiff = bounds.east - bounds.west;

  // Simple zoom calculation
  const maxDiff = Math.max(latDiff, lonDiff);

  if (maxDiff > 10) return 8;
  if (maxDiff > 5) return 10;
  if (maxDiff > 1) return 12;
  if (maxDiff > 0.5) return 14;
  if (maxDiff > 0.1) return 16;
  return 18;
}

/**
 * Generate GeoJSON from markers
 * @param {array} markers - Markers data
 * @param {string} lang - Language
 * @returns {object} - GeoJSON FeatureCollection
 */
function generateGeoJSON(markers, lang = 'eng') {
  const features = markers.map(marker => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [marker.longitude, marker.latitude]
    },
    properties: {
      id: marker.id,
      type: marker.type,
      title: marker.title,
      distance: marker.distance,
      direction: marker.direction,
      address: marker.address,
      emoji: marker.emoji,
      color: marker.color
    }
  }));

  return {
    type: 'FeatureCollection',
    features: features
  };
}

/**
 * Generate KML from markers (for export to Google Earth)
 * @param {array} markers - Markers data
 * @param {string} lang - Language
 * @returns {string} - KML string
 */
function generateKML(markers, lang = 'eng') {
  const placemarks = markers.map(marker => `
    <Placemark>
      <name>${marker.title}</name>
      <description>
        ${marker.type === 'friend' ? `Distance: ${marker.distance} km<br/>Direction: ${marker.direction}<br/>Address: ${marker.address}` : 'Your location'}
      </description>
      <Point>
        <coordinates>${marker.longitude},${marker.latitude},0</coordinates>
      </Point>
      <Style>
        <IconStyle>
          <Icon>
            <href>http://maps.google.com/mapfiles/ms/icons/${getKMLColor(marker.color)}-dot.png</href>
          </Icon>
        </IconStyle>
      </Style>
    </Placemark>
  `).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
    <kml xmlns="http://www.opengis.net/kml/2.2">
      <Document>
        <name>Friends Locations</name>
        <description>Friend locations map</description>
        ${placemarks}
      </Document>
    </kml>`;
}

/**
 * Convert color to KML color code
 */
function getKMLColor(hexColor) {
  const colorMap = {
    '#FF0000': 'red',
    '#FF6600': 'orange',
    '#FFCC00': 'yellow',
    '#00CC00': 'green',
    '#0066FF': 'blue',
    '#0066CC': 'blue'
  };
  return colorMap[hexColor] || 'blue';
}

/**
 * Generate static map image URL (using static map service)
 * @param {array} markers - Markers data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {string} - Static map image URL
 */
function generateStaticMapURL(markers, width = 600, height = 400) {
  if (markers.length === 0) return '';

  // Using OpenStreetMap Static API (alternative services available)
  const center = markers[0];
  const zoom = 13;

  // For production, use a proper static map service like:
  // - Google Static Maps API
  // - Mapbox Static API
  // - OpenStreetMap tile services

  return `https://api.mapbox.com/styles/v1/mapbox/streets-v11/static/${center.longitude},${center.latitude},${zoom},0/${width}x${height}@2x`;
}

module.exports = {
  generateMapMarkers,
  getIconForDistance,
  getColorForDistance,
  getEmojiForDistance,
  calculateMapBounds,
  generateMapHTML,
  generateMapData,
  calculateOptimalZoom,
  generateGeoJSON,
  generateKML,
  generateStaticMapURL
};
