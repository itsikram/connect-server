/**
 * Location Routes
 * Handles connect location queries and sharing
 */

const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const {
  getConnectsNearby,
  getConnectsLocationRaw,
  shareLocation,
  getConnectLocation,
  searchNearby,
} = require("../controllers/locationController");
const {
  chatLocationQuery,
  getConnectDetailsForChat,
  getBulkConnectDetails,
  getChatConnectsList,
} = require("../controllers/chatLocationController");
const {
  getMapData,
  getGeoJSON,
  getKML,
  getMapEmbedHTML,
  getNearbySummary,
} = require("../controllers/mapLocationController");

/**
 * GET /api/location/connects-nearby
 * Get connects nearby based on user's current location
 * Query params: latitude, longitude, lang (eng/bn), radius (km)
 *
 * Example: /api/location/connects-nearby?latitude=23.8103&longitude=90.4125&lang=bn&radius=50
 */
Router.get("/connects-nearby", isAuth, getConnectsNearby);

/**
 * GET /api/location/connects-location-raw
 * Get raw location data for connects (for map display)
 * Query params: latitude, longitude, lang
 */
Router.get("/connects-location-raw", isAuth, getConnectsLocationRaw);

/**
 * POST /api/location/share-location
 * Share/update user's current location
 * Body: { latitude, longitude, lang }
 *
 * Example: POST /api/location/share-location
 * { "latitude": 23.8103, "longitude": 90.4125, "lang": "bn" }
 */
Router.post("/share-location", isAuth, shareLocation);

/**
 * GET /api/location/connect/:connectId
 * Get specific connect's location
 * Query params: lang (eng/bn)
 */
Router.get("/connect/:connectId", isAuth, getConnectLocation);

/**
 * POST /api/location/search-nearby
 * AI-powered search for nearby connects with natural language query
 * Body: { latitude, longitude, query, lang }
 *
 * Example: POST /api/location/search-nearby
 * {
 *   "latitude": 23.8103,
 *   "longitude": 90.4125,
 *   "query": "find my close connects",
 *   "lang": "bn"
 * }
 */
Router.post("/search-nearby", isAuth, searchNearby);

/**
 * POST /api/location/chat
 * AI Chat endpoint for natural language connect location queries
 * Body: { latitude, longitude, message, lang }
 *
 * Example: POST /api/location/chat
 * {
 *   "latitude": 23.8103,
 *   "longitude": 90.4125,
 *   "message": "আমার কাছে কে কে আছে?",
 *   "lang": "bn"
 * }
 */
Router.post("/chat", isAuth, chatLocationQuery);

/**
 * GET /api/location/connect-details/:connectId
 * Get complete connect details for chat display
 * Query params: lang (eng/bn)
 */
Router.get("/connect-details/:connectId", isAuth, getConnectDetailsForChat);

/**
 * POST /api/location/bulk-connect-details
 * Get details for multiple connects at once
 * Body: { connectIds: [], lang }
 */
Router.post("/bulk-connect-details", isAuth, getBulkConnectDetails);

/**
 * POST /api/location/chat-list-connects
 * Get formatted list of all connects for chat display
 * Body: { latitude, longitude, lang }
 */
Router.post("/chat-list-connects", isAuth, getChatConnectsList);

/**
 * GET /api/location/map-data
 * Get map data for connect locations visualization
 * Query params: latitude, longitude, lang, radius
 */
Router.get("/map-data", isAuth, getMapData);

/**
 * GET /api/location/geojson
 * Get GeoJSON format data for map libraries
 * Query params: latitude, longitude, lang, radius
 */
Router.get("/geojson", isAuth, getGeoJSON);

/**
 * GET /api/location/kml
 * Export connect locations as KML (for Google Earth)
 * Query params: latitude, longitude, lang, radius
 */
Router.get("/kml", isAuth, getKML);

/**
 * GET /api/location/map-embed-html
 * Get embeddable HTML for displaying map
 * Query params: latitude, longitude, lang, mapId, height, radius
 */
Router.get("/map-embed-html", isAuth, getMapEmbedHTML);

/**
 * POST /api/location/nearby-summary
 * Get summary of nearby connects with categorization
 * Body: { latitude, longitude, lang, radius }
 */
Router.post("/nearby-summary", isAuth, getNearbySummary);

module.exports = Router;
