# Location API Documentation
## AI-Powered Friend Location Discovery

This documentation covers the complete Location API for finding friends based on geographic coordinates with support for both Bengali and English.

---

## Overview

The Location API provides AI-powered functionality to:
- Get friends nearby based on user's current location coordinates
- Calculate distances and directions to friends
- Search for friends with natural language queries
- Share real-time location with friends
- Get location-based recommendations

All responses support both **English (eng)** and **Bengali (bn)** languages.

---

## Core Endpoints

### 1. Get Friends Nearby
**Endpoint:** `GET /api/location/friends-nearby`

**Description:** Get a list of friends nearby based on user's current location coordinates with AI-formatted response.

**Authentication:** Required (Bearer Token)

**Query Parameters:**
```
- latitude (required): float - User's latitude (-90 to 90)
- longitude (required): float - User's longitude (-180 to 180)
- lang (optional): string - 'eng' (default) or 'bn'
- radius (optional): number - Search radius in kilometers (default: 50)
```

**Example Request:**
```
GET /api/location/friends-nearby?latitude=23.8103&longitude=90.4125&lang=bn&radius=50
Authorization: Bearer YOUR_TOKEN
```

**Example Response (Bengali):**
```json
{
  "success": true,
  "greeting": "আমি আপনার বর্তমান অবস্থানের উপর ভি
