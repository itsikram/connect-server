/**
 * Map Location Controller
 * Handles map-based location visualization
 */

const Profile = require("../models/Profile");
const { getFriendsLocations } = require("../services/ai/locationService");
const {
  generateMapData,
  generateGeoJSON,
  generateKML,
} = require("../services/ai/mapService/mapLocationService");
const { translate } = require("../utils/localization/translations");

/**
 * GET /api/location/map-data
 * Get map data for friend locations
 * Query params: latitude, longitude, lang (optional)
 */
exports.getMapData = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng", radius = 100 } = req.query;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 100;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    // Get friends locations
    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    // Generate map data
    const mapData = generateMapData(
      locationData.friends,
      { latitude: lat, longitude: lon },
      lang,
    );

    return res.status(200).json({
      success: true,
      map: mapData,
      userLocation: { latitude: lat, longitude: lon },
      radius: radiusKm,
      language: lang,
    });
  } catch (error) {
    console.error("Error in getMapData:", error);
    next(error);
  }
};

/**
 * GET /api/location/geojson
 * Get GeoJSON format data for map libraries
 * Query params: latitude, longitude, lang
 */
exports.getGeoJSON = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng", radius = 100 } = req.query;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 100;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    const mapData = generateMapData(
      locationData.friends,
      { latitude: lat, longitude: lon },
      lang,
    );

    const geoJSON = generateGeoJSON(mapData.markers, lang);

    return res.status(200).json({
      success: true,
      type: "FeatureCollection",
      features: geoJSON.features,
      bounds: mapData.bounds,
      center: mapData.center,
    });
  } catch (error) {
    console.error("Error in getGeoJSON:", error);
    next(error);
  }
};

/**
 * GET /api/location/kml
 * Export friend locations as KML (for Google Earth)
 * Query params: latitude, longitude, lang
 */
exports.getKML = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng", radius = 100 } = req.query;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 100;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    const mapData = generateMapData(
      locationData.friends,
      { latitude: lat, longitude: lon },
      lang,
    );

    const kml = generateKML(mapData.markers, lang);

    // Return as file
    res.header("Content-Type", "application/vnd.google-earth.kml+xml");
    res.header(
      "Content-Disposition",
      'attachment; filename="friends-locations.kml"',
    );
    return res.send(kml);
  } catch (error) {
    console.error("Error in getKML:", error);
    next(error);
  }
};

/**
 * GET /api/location/map-embed-html
 * Get embeddable HTML for displaying map
 * Query params: latitude, longitude, lang, mapId, height
 */
exports.getMapEmbedHTML = async (req, res, next) => {
  try {
    const {
      latitude,
      longitude,
      lang = "eng",
      mapId = "friendsMap",
      height = 500,
      radius = 100,
    } = req.query;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 100;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    const mapData = generateMapData(
      locationData.friends,
      { latitude: lat, longitude: lon },
      lang,
    );

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>${lang === "bn" ? "বন্ধুদের অবস্থান মানচিত্র" : "Friends Location Map"}</title>
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
      <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
      <style>
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        #${mapId} { width: 100%; height: ${height}px; }
        .marker-tooltip {
          background: white;
          padding: 10px;
          border-radius: 5px;
          box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        }
        .info-box {
          background: #f0f0f0;
          padding: 15px;
          margin: 10px;
          border-radius: 5px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
      </style>
    </head>
    <body>
      <div class="info-box">
        <h2>${lang === "bn" ? "📍 বন্ধুদের অবস্থান" : "📍 Friends Locations"}</h2>
        <p>${lang === "bn" ? `মোট বন্ধু: ${mapData.totalMarkers - 1}` : `Total Friends: ${mapData.totalMarkers - 1}`}</p>
      </div>
      <div id="${mapId}"></div>

      <script>
        const mapData = ${JSON.stringify(mapData)};

        // Initialize map
        const map = L.map('${mapId}').setView(
          [${mapData.center.latitude}, ${mapData.center.longitude}],
          ${mapData.zoom}
        );

        // Add tile layer
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '© OpenStreetMap contributors',
          maxZoom: 19
        }).addTo(map);

        // Add markers
        mapData.markers.forEach(marker => {
          const icon = L.divIcon({
            html: marker.emoji || '📍',
            className: 'custom-marker',
            iconSize: [40, 40],
            iconAnchor: [20, 40],
            popupAnchor: [0, -40]
          });

          let popupContent = '<div style="text-align: center; padding: 10px; min-width: 200px;">';
          popupContent += '<strong>' + marker.title + '</strong>';

          if (marker.type === 'friend') {
            popupContent += '<br/><div style="font-size: 12px; margin: 5px 0;">' + marker.distance.toFixed(2) + ' km away</div>';
            if (marker.direction) popupContent += '<div style="font-size: 12px;">' + marker.direction + '</div>';
            if (marker.address) popupContent += '<div style="font-size: 12px;">' + marker.address + '</div>';
          }

          popupContent += '</div>';

          L.marker([marker.latitude, marker.longitude], { icon: icon })
            .bindPopup(popupContent)
            .addTo(map);
        });

        // Fit bounds
        if (mapData.markers.length > 1) {
          const bounds = L.latLngBounds(
            [${mapData.bounds.south}, ${mapData.bounds.west}],
            [${mapData.bounds.north}, ${mapData.bounds.east}]
          );
          map.fitBounds(bounds, { padding: [50, 50] });
        }
      </script>
    </body>
    </html>
    `;

    res.header("Content-Type", "text/html; charset=utf-8");
    return res.send(htmlContent);
  } catch (error) {
    console.error("Error in getMapEmbedHTML:", error);
    next(error);
  }
};

/**
 * POST /api/location/nearby-summary
 * Get summary of nearby friends for display
 * Body: { latitude, longitude, lang }
 */
exports.getNearbySummary = async (req, res, next) => {
  try {
    const { latitude, longitude, lang = "eng", radius = 50 } = req.body;
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: true,
        message: translate("unauthorizedAccess", lang),
      });
    }

    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const radiusKm = parseFloat(radius) || 50;

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        error: true,
        message: translate("invalidLocation", lang),
      });
    }

    const userProfile = await Profile.findById(profileId);
    if (!userProfile) {
      return res.status(404).json({
        error: true,
        message: translate("profileNotFound", lang),
      });
    }

    const locationData = await getFriendsLocations(userProfile, lat, lon, {
      lang,
      radiusKm,
    });

    const nearbyFriends = locationData.friends.filter(
      (f) => f.distance !== null && f.distance <= radiusKm,
    );

    // Group by distance category
    const categories = {
      veryClose: nearbyFriends.filter((f) => f.distance < 0.5),
      close: nearbyFriends.filter((f) => f.distance >= 0.5 && f.distance < 2),
      nearby: nearbyFriends.filter((f) => f.distance >= 2 && f.distance < 10),
      moderate: nearbyFriends.filter(
        (f) => f.distance >= 10 && f.distance < 50,
      ),
    };

    return res.status(200).json({
      success: true,
      summary: {
        total: locationData.summary.total,
        nearby: nearbyFriends.length,
        categories: {
          veryClose: {
            label:
              lang === "bn"
                ? "🔴 খুব কাছে (< 0.5 কিমি)"
                : "🔴 Very Close (< 0.5 km)",
            count: categories.veryClose.length,
            friends: categories.veryClose,
          },
          close: {
            label:
              lang === "bn"
                ? "🟠 কাছাকাছি (0.5-2 কিমি)"
                : "🟠 Close (0.5-2 km)",
            count: categories.close.length,
            friends: categories.close,
          },
          nearby: {
            label:
              lang === "bn"
                ? "🟡 খুবই কাছে (2-10 কিমি)"
                : "🟡 Nearby (2-10 km)",
            count: categories.nearby.length,
            friends: categories.nearby,
          },
          moderate: {
            label:
              lang === "bn"
                ? "🟢 মধ্যম দূরত্ব (10-50 কিমি)"
                : "🟢 Moderate (10-50 km)",
            count: categories.moderate.length,
            friends: categories.moderate,
          },
        },
      },
      language: lang,
    });
  } catch (error) {
    console.error("Error in getNearbySummary:", error);
    next(error);
  }
};

// Exports are already defined with exports.functionName above
