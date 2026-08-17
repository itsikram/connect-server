/**
 * Location Routes
 * Handles friend location queries and sharing
 */

const Router = require("express").Router();
const isAuth = require("../middlewares/isAuth");
const {
  getFriendsNearby,
  getFriendsLocationRaw,
  shareLocation,
  getFriendLocation,
  searchNearby,
} = require("../controllers/locationController");
const {
  chatLocationQuery,
  getFriendDetailsForChat,
  getBulkFriendDetails,
  getChatFriendsList,
} = require("../controllers/chatLocationController");
const {
  getMapData,
  getGeoJSON,
  getKML,
  getMapEmbedHTML,
  getNearbySummary,
} = require("../controllers/mapLocationController");

/**
 * GET /api/location/friends-nearby
 * Get friends nearby based on user's current location
 * Query params: latitude, longitude, lang (eng/bn), radius (km)
 *
 * Example: /api/location/friends-nearby?latitude=23.8103&longitude=90.4125&lang=bn&radius=50
 */
Router.get("/friends-nearby", isAuth, getFriendsNearby);

/**
 * GET /api/location/friends-location-raw
 * Get raw location data for friends (for map display)
 * Query params: latitude, longitude, lang
 */
Router.get("/friends-location-raw", isAuth, getFriendsLocationRaw);

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
 * GET /api/location/friend/:friendId
 * Get specific friend's location
 * Query params: lang (eng/bn)
 */
Router.get("/friend/:friendId", isAuth, getFriendLocation);

/**
 * POST /api/location/search-nearby
 * AI-powered search for nearby friends with natural language query
 * Body: { latitude, longitude, query, lang }
 *
 * Example: POST /api/location/search-nearby
 * {
 *   "latitude": 23.8103,
 *   "longitude": 90.4125,
 *   "query": "find my close friends",
 *   "lang": "bn"
 * }
 */
Router.post("/search-nearby", isAuth, searchNearby);

/**
 * POST /api/location/chat
 * AI Chat endpoint for natural language friend location queries
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
 * GET /api/location/friend-details/:friendId
 * Get complete friend details for chat display
 * Query params: lang (eng/bn)
 */
Router.get("/friend-details/:friendId", isAuth, getFriendDetailsForChat);

/**
 * POST /api/location/bulk-friend-details
 * Get details for multiple friends at once
 * Body: { friendIds: [], lang }
 */
Router.post("/bulk-friend-details", isAuth, getBulkFriendDetails);

/**
 * POST /api/location/chat-list-friends
 * Get formatted list of all friends for chat display
 * Body: { latitude, longitude, lang }
 */
Router.post("/chat-list-friends", isAuth, getChatFriendsList);

/**
 * GET /api/location/map-data
 * Get map data for friend locations visualization
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
 * Export friend locations as KML (for Google Earth)
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
 * Get summary of nearby friends with categorization
 * Body: { latitude, longitude, lang, radius }
 */
Router.post("/nearby-summary", isAuth, getNearbySummary);

module.exports = Router;
