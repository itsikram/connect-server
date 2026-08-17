# Location Map Integration Guide
## Display Friend Locations on Leaflet Maps

---

## Overview

The Location API now includes comprehensive map integration features to display friend locations on interactive Leaflet maps. All responses include map-ready data in multiple formats.

### Features
✅ **Interactive Leaflet Maps** - Real-time friend locations with markers
✅ **GeoJSON Export** - Compatible with any map library
✅ **KML Export** - Open in Google Earth
✅ **Responsive Design** - Works on mobile and desktop
✅ **Distance-based Markers** - Color-coded by proximity
✅ **Bilingual Support** - Bengali and English labels

---

## Map Endpoints

### 1. Get Map Data
**Endpoint**: `GET /api/location/map-data`

**Query Parameters**:
- `latitude` (required): User's latitude
- `longitude` (required): User's longitude
- `lang` (optional): `eng` or `bn` (default: `eng`)
- `radius` (optional): Search radius in km (default: 100)

**Example Request**:
```
GET /api/location/map-data?latitude=23.8103&longitude=90.4125&lang=bn&radius=100
Authorization: Bearer YOUR_TOKEN
```

**Response**:
```json
{
  "success": true,
  "map": {
    "markers": [
      {
        "id": "user",
        "type": "user",
        "latitude": 23.8103,
        "longitude": 90.4125,
        "title": "আপনার অবস্থান",
        "emoji": "📍",
        "color": "#0066CC",
        "zIndex": 1000
      },
      {
        "id": "65f1a2b3c4d5e6f7g8h9i0j1",
        "type": "friend",
        "latitude": 23.8200,
        "longitude": 90.4200,
        "title": "রহিম সাহেব",
        "distance": 1.25,
        "direction": "উত্তর-পূর্ব",
        "address": "ঢাকা, বাংলাদেশ",
        "emoji": "🔴",
        "color": "#FF0000",
        "zIndex": 999
      }
    ],
    "bounds": {
      "north": 23.8410,
      "south": 23.7896,
      "east": 90.4410,
      "west": 90.3990,
      "center": {
        "latitude": 23.8153,
        "longitude": 90.4200
      }
    },
    "zoom": 13,
    "totalMarkers": 3
  },
  "userLocation": {
    "latitude": 23.8103,
    "longitude": 90.4125
  },
  "radius": 100,
  "language": "bn"
}
```

---

### 2. Get GeoJSON Data
**Endpoint**: `GET /api/location/geojson`

**Query Parameters**: Same as `/map-data`

**Response**:
```json
{
  "success": true,
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Point",
        "coordinates": [90.4200, 23.8200]
      },
      "properties": {
        "id": "65f1a2b3c4d5e6f7g8h9i0j1",
        "type": "friend",
        "title": "রহিম সাহেব",
        "distance": 1.25,
        "direction": "উত্তর-পূর্ব",
        "address": "ঢাকা",
        "emoji": "🔴",
        "color": "#FF0000"
      }
    }
  ],
  "bounds": {...},
  "center": {
    "latitude": 23.8153,
    "longitude": 90.4200
  }
}
```

---

### 3. Get KML Export
**Endpoint**: `GET /api/location/kml`

**Query Parameters**: Same as `/map-data`

**Response**: Downloads `friends-locations.kml` file for Google Earth

---

### 4. Get Embeddable HTML Map
**Endpoint**: `GET /api/location/map-embed-html`

**Query Parameters**:
- `latitude`, `longitude`, `lang` (same as before)
- `mapId` (optional): HTML element ID (default: `friendsMap`)
- `height` (optional): Map height in pixels (default: 500)
- `radius` (optional): Search radius (default: 100)

**Response**: Complete HTML page with interactive map

**Usage**:
```html
<!-- Create an iframe or embed the map -->
<iframe 
  src="/api/location/map-embed-html?latitude=23.8103&longitude=90.4125&lang=bn&height=600"
  width="100%" 
  height="600"
  frameborder="0"
  style="border-radius: 8px;">
</iframe>
```

---

### 5. Get Nearby Friends Summary
**Endpoint**: `POST /api/location/nearby-summary`

**Request Body**:
```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "lang": "bn",
  "radius": 50
}
```

**Response**:
```json
{
  "success": true,
  "summary": {
    "total": 5,
    "nearby": 3,
    "categories": {
      "veryClose": {
        "label": "🔴 খুব কাছে (< 0.5 কিমি)",
        "count": 1,
        "friends": [
          {
            "id": "...",
            "name": "রহিম সাহেব",
            "distance": 0.3,
            "direction": "উত্তর"
          }
        ]
      },
      "close": {
        "label": "🟠 কাছাকাছি (0.5-2 কিমি)",
        "count": 1,
        "friends": [...]
      },
      "nearby": {
        "label": "🟡 খুবই কাছে (2-10 কিমি)",
        "count": 1,
        "friends": [...]
      },
      "moderate": {
        "label": "🟢 মধ্যম দূরত্ব (10-50 কিমি)",
        "count": 0,
        "friends": []
      }
    }
  },
  "language": "bn"
}
```

---

## Map Integration Examples

### Example 1: Display Map with Leaflet

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
  <style>
    #map { height: 500px; }
  </style>
</head>
<body>
  <div id="map"></div>

  <script>
    async function displayFriendsMap(latitude, longitude) {
      // Get map data from API
      const response = await fetch(
        `/api/location/map-data?latitude=${latitude}&longitude=${longitude}&lang=bn`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );
      const data = await response.json();

      // Initialize map
      const map = L.map('map').setView(
        [data.map.center.latitude, data.map.center.longitude],
        data.map.zoom
      );

      // Add tile layer
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);

      // Add markers
      data.map.markers.forEach(marker => {
        const icon = L.divIcon({
          html: marker.emoji || '📍',
          className: 'custom-marker',
          iconSize: [40, 40],
          iconAnchor: [20, 40],
          popupAnchor: [0, -40]
        });

        let popupHTML = `<strong>${marker.title}</strong>`;
        if (marker.distance) {
          popupHTML += `<br/>দূরত্ব: ${marker.distance.toFixed(2)} কিমি`;
          popupHTML += `<br/>দিক: ${marker.direction}`;
        }

        L.marker([marker.latitude, marker.longitude], { icon: icon })
          .bindPopup(popupHTML)
          .addTo(map);
      });

      // Fit bounds
      const bounds = L.latLngBounds(
        [data.map.bounds.south, data.map.bounds.west],
        [data.map.bounds.north, data.map.bounds.east]
      );
      map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Display map when page loads
    displayFriendsMap(23.8103, 90.4125);
  </script>
</body>
</html>
```

### Example 2: Load GeoJSON on Map

```javascript
async function displayGeoJSONMap(latitude, longitude) {
  const response = await fetch(
    `/api/location/geojson?latitude=${latitude}&longitude=${longitude}`,
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );
  const geojson = await response.json();

  // Add GeoJSON layer to map
  L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const popup = `
        <strong>${feature.properties.title}</strong><br/>
        Distance: ${feature.properties.distance} km<br/>
        ${feature.properties.emoji}
      `;
      return L.marker(latlng).bindPopup(popup);
    }
  }).addTo(map);
}
```

### Example 3: Display Summary with Categories

```javascript
async function displayFriendsSummary(latitude, longitude) {
  const response = await fetch('/api/location/nearby-summary', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      latitude,
      longitude,
      lang: 'bn',
      radius: 50
    })
  });

  const data = await response.json();

  // Display summary
  const html = `
    <div class="summary">
      <h3>কাছাকাছি বন্ধুরা</h3>
      <p>মোট: ${data.summary.nearby} জন</p>
      
      ${Object.entries(data.summary.categories).map(([key, category]) => `
        <div class="category">
          <h4>${category.label} (${category.count})</h4>
          <ul>
            ${category.friends.map(friend => `
              <li>
                ${friend.name} - ${friend.distance.toFixed(2)} কিমি দূরে
                (${friend.direction})
              </li>
            `).join('')}
          </ul>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('summary').innerHTML = html;
}
```

### Example 4: Export KML for Google Earth

```javascript
async function exportToKML(latitude, longitude) {
  const response = await fetch(
    `/api/location/kml?latitude=${latitude}&longitude=${longitude}&lang=bn`,
    {
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );

  // Download file
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'friends-locations.kml';
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}
```

---

## Marker Colors & Emojis

| Distance | Color | Emoji | Meaning |
|----------|-------|-------|---------|
| < 0.5 km | 🔴 Red | 🔴 | Very Close |
| 0.5-2 km | 🟠 Orange | 🟠 | Close |
| 2-10 km | 🟡 Yellow | 🟡 | Nearby |
| 10-50 km | 🟢 Green | 🟢 | Moderate |
| > 50 km | 🔵 Blue | 🔵 | Far |
| Your Location | - | 📍 | Your Position |

---

## Integration with Chat API

The chat endpoint now includes map data:

```json
{
  "success": true,
  "message": "...",
  "map": {
    "markers": [...],
    "bounds": {...},
    "center": {...},
    "zoom": 13,
    "totalMarkers": 3
  },
  "geojson": {
    "type": "FeatureCollection",
    "features": [...]
  }
}
```

---

## Responsive Design

All maps are responsive and work on:
- Desktop browsers
- Tablets
- Mobile devices
- PWA installations

---

## Performance Tips

1. **Cache map data** to reduce API calls
2. **Use GeoJSON** for static maps
3. **Update location** every 5-10 minutes for real-time tracking
4. **Limit markers** by radius parameter
5. **Use clustering** for maps with many markers (future enhancement)

---

## Browser Compatibility

✅ Chrome/Edge 60+
✅ Firefox 55+
✅ Safari 11+
✅ Mobile browsers (iOS Safari, Chrome Mobile)

---

## File Formats

### Supported Export Formats
- **GeoJSON** - Web standard, compatible with most mapping libraries
- **KML** - Google Earth compatible
- **HTML** - Self-contained embeddable maps
- **JSON** - Custom format with metadata

---

## API Response Headers

```
Content-Type: application/json (for data endpoints)
Content-Type: application/vnd.google-earth.kml+xml (for KML)
Content-Type: text/html (for HTML embed)
Content-Type: application/geo+json (for GeoJSON)
```

---

## Error Handling

All map endpoints follow the same error format:

```json
{
  "error": true,
  "message": "Error description",
  "code": "ERROR_CODE"
}
```

---

## Future Enhancements

🔜 **Marker Clustering** - Group nearby markers
