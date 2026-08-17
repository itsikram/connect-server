# Location & Chat API Documentation
## AI-Powered Friend Location Discovery with Chat Interface

---

## Table of Contents
1. [Overview](#overview)
2. [Chat Endpoints](#chat-endpoints)
3. [Location Endpoints](#location-endpoints)
4. [Response Examples](#response-examples)
5. [Error Handling](#error-handling)
6. [Usage Examples](#usage-examples)

---

## Overview

The Location Chat API provides AI-powered functionality to:
- **Chat naturally** about friend locations in Bengali or English
- Get detailed information about friends with full profiles
- Calculate distances and directions
- Real-time location sharing
- Get formatted friend lists for chat display

### Supported Languages
- **English**: `lang=eng`
- **Bengali**: `lang=bn`

### Authentication
All endpoints require Bearer Token authentication:
```
Authorization: Bearer YOUR_JWT_TOKEN
```

---

## Chat Endpoints

### 1. AI Location Chat Query
**Endpoint**: `POST /api/location/chat`

**Description**: Send a natural language query about friend locations and get an AI response with all details.

**Request Body**:
```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "message": "কে কে আমার কাছে আছে?",
  "lang": "bn"
}
```

**Response (Bengali)**:
```json
{
  "success": true,
  "greeting": "চমৎকার! আমি আপনার কাছে 2 জন বন্ধু খুঁজে পেয়েছি। এখানে সবার বিস্তারিত তথ্য রয়েছে:",
  "summary": "📊 **সংক্ষিপ্ত বিবরণ:**\n- মোট বন্ধু: 5\n- 50 কিমির মধ্যে কাছাকাছি: 2\n- অবস্থান শেয়ার করেছেন: 4",
  "totalFriendsWithLocation": 4,
  "totalNearby": 2,
  "details": [
    {
      "name": "রহিম সাহেব",
      "distance": "1.25 km",
      "direction": "উত্তর-পূর্ব",
      "message": "রহিম সাহেব আপনার খুব কাছে - মাত্র 1.25 কিমি দূরে",
      "address": "ঢাকা, বাংলাদেশ"
    },
    {
      "name": "ফাতিমা বেগম",
      "distance": "3.50 km",
      "direction": "দক্ষিণ",
      "message": "ফাতিমা বেগম কাছাকাছি - প্রায় 3.50 কিমি দূরে",
      "address": "ঢাকা শহর"
    }
  ],
  "friendsWithoutLocation": 3,
  "message": "👥 **কাছাকাছি বন্ধুদের বিস্তারিত:**\n\n🥇 **রহিম সাহেব**\n   📏 দূরত্ব: 1.25 কিমি\n   🧭 দিক: উত্তর-পূর্ব\n   📍 ঠিকানা: ঢাকা, বাংলাদেশ\n   ℹ️ বর্ণনা: রহিম সাহেব আপনার খুব কাছে - মাত্র 1.25 কিমি দূরে\n\n🥈 **ফাতিমা বেগম**\n   📏 দূরত্ব: 3.50 কিমি\n   🧭 দিক: দক্ষিণ\n   📍 ঠিকানা: ঢাকা শহর\n   ℹ️ বর্ণনা: ফাতিমা বেগম কাছাকাছি - প্রায় 3.50 কিমি দূরে\n\n💡 **সহায়ক পরামর্শ:**\n✓ আপনার সবচেয়ে কাছের বন্ধু হল রহিম সাহেব (1.25 কিমি দূরে)\n✓ গড় দূরত্ব: 2.38 কিমি\n✓ আপনি বন্ধুদের সাথে দেখা করতে পারেন!",
  "queryType": "general",
  "timestamp": "2024-08-17T10:30:45.123Z",
  "language": "bn"
}
```

**Query Examples** (Natural Language Support):
- Bengali: "কে কে আমার কাছে আছে?"
- English: "Who is near me?"
- Bengali: "আমার কাছের বন্ধুরা কোথায়?"
- English: "Where are my close friends?"

---

### 2. Get Friend Complete Details
**Endpoint**: `GET /api/location/friend-details/:friendId`

**Query Parameters**:
- `lang` (optional): `eng` or `bn` (default: `eng`)

**Example Request**:
```
GET /api/location/friend-details/65f1a2b3c4d5e6f7g8h9i0j1?lang=bn
Authorization: Bearer YOUR_TOKEN
```

**Response (Bengali)**:
```json
{
  "success": true,
  "message": "👤 **রহিম সাহেব এর সম্পূর্ণ তথ্য:**\n\n**ব্যক্তিগত তথ্য:**\n   • ডিসপ্লে নাম: Rahim\n   • ইউজারনাম: rahim_saheb\n   • ইমেইল: rahim@example.com\n   • বায়ো: আমি একজন সফটওয়্যার ডেভেলপার\n\n**অবস্থান:**\n   • অক্ষাংশ: 23.8103\n   • দ্রাঘিমাংশ: 90.4125\n\n**ঠিকানা:**\n   • বর্তমান: ঢাকা, বাংলাদেশ\n   • স্থায়ী: চট্টগ্রাম, বাংলাদেশ\n\n**কর্মক্ষেত্র:**\n   • TechCorp Bangladesh (Senior Developer)\n\n**শিক্ষা প্রতিষ্ঠান:**\n   • ঢাকা বিশ্ববিদ্যালয় (B.Sc in Computer Science)\n\n**স্থিতি:**\n   • সক্রিয়: হ্যাঁ ✓\n   • মেজাজ: Happy",
  "friend": {
    "id": "65f1a2b3c4d5e6f7g8h9i0j1",
    "name": "রহিম সাহেব",
    "profilePic": "https://example.com/pic.jpg",
    "isActive": true
  }
}
```

---

### 3. Get Bulk Friend Details
**Endpoint**: `POST /api/location/bulk-friend-details`

**Request Body**:
```json
{
  "friendIds": [
    "65f1a2b3c4d5e6f7g8h9i0j1",
    "65f1a2b3c4d5e6f7g8h9i0j2",
    "65f1a2b3c4d5e6f7g8h9i0j3"
  ],
  "lang": "bn"
}
```

**Response**:
```json
{
  "success": true,
  "count": 3,
  "friends": [
    {
      "success": true,
      "message": "👤 **রহিম সাহেব এর সম্পূর্ণ তথ্য:** ...",
      "friend": {
        "id": "65f1a2b3c4d5e6f7g8h9i0j1",
        "name": "রহিম সাহেব",
        "isActive": true
      }
    }
  ],
  "language": "bn"
}
```

---

### 4. Get Formatted Friends List for Chat
**Endpoint**: `POST /api/location/chat-list-friends`

**Request Body**:
```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "lang": "bn"
}
```

**Response (Bengali)**:
```json
{
  "success": true,
  "message": "👥 **আপনার 5 জন বন্ধু রয়েছে:**\n\n1. 🔴 **রহিম সাহেব**\n   📍 1.25 কিমি দূরে\n   📌 ঢাকা, বাংলাদেশ\n   🟢 সক্রিয়\n\n2. 🟠 **ফাতিমা বেগম**\n   📍 3.50 কিমি দূরে\n   📌 ঢাকা শহর\n   🟢 সক্রিয়\n...",
  "friends": [
    {
      "index": 1,
      "id": "65f1a2b3c4d5e6f7g8h9i0j1",
      "name": "রহিম সাহেব",
      "profilePic": "https://example.com/pic1.jpg",
      "isActive": true,
      "address": "ঢাকা, বাংলাদেশ",
      "distance": {
        "distance": 1.25,
        "latitude": 23.8103,
        "longitude": 90.4125,
        "hasLocation": true
      },
      "emoji": "🔴"
    }
  ],
  "total": 5,
  "nearbyCount": 2,
  "language": "bn"
}
```

**Distance Emojis**:
- 🔴 Very Close (< 0.5 km)
- 🟠 Close (< 2 km)
- 🟡 Nearby (< 10 km)
- 🟢 Moderate (< 50 km)
- 🔵 Far (> 50 km)
- ❓ No Location

---

## Location Endpoints

### 1. Get Friends Nearby
**Endpoint**: `GET /api/location/friends-nearby`

**Query Parameters**:
- `latitude` (required): User's latitude
- `longitude` (required): User's longitude
- `lang` (optional): `eng` or `bn` (default: `eng`)
- `radius` (optional): Search radius in km (default: 50)

**Example**:
```
GET /api/location/friends-nearby?latitude=23.8103&longitude=90.4125&lang=bn&radius=50
```

---

### 2. Share Location
**Endpoint**: `POST /api/location/share-location`

**Request Body**:
```json
{
  "latitude": 23.8103,
  "longitude": 90.4125,
  "lang": "bn"
}
```

**Response**:
```json
{
  "success": true,
  "message": "আপনার অবস্থান সফলভাবে আপডেট হয়েছে।",
  "location": {
    "latitude": 23.8103,
    "longitude": 90.4125,
    "timestamp": "2024-08-17T10:30:45.123Z"
  }
}
```

---

### 3. Get Specific Friend's Location
**Endpoint**: `GET /api/location/friend/:friendId`

**Query Parameters**:
- `lang` (optional): `eng` or `bn`

**Example**:
```
GET /api/location/friend/65f1a2b3c4d5e6f7g8h9i0j1?lang=bn
```

---

## Response Examples

### Success Response Format
```json
{
  "success": true,
  "message": "Detailed response message",
  "friends": [...],
  "summary": {...},
  "metadata": {...},
  "language": "bn"
}
```

### Error Response Format
```json
{
  "error": true,
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE"
}
```

---

## Error Handling

### Common Error Codes

| Code | Message | Status |
|------|---------|--------|
| `UNAUTHORIZED` | Unauthorized access | 401 |
| `INVALID_LOCATION` | Invalid coordinates | 400 |
| `PROFILE_NOT_FOUND` | Profile not found | 404 |
| `NOT_FRIEND` | Not in friends list | 403 |
| `INVALID_LANGUAGE` | Unsupported language | 400 |
| `MISSING_COORDINATES` | Missing latitude/longitude | 400 |

---

## Usage Examples

### Example 1: Get Friends Via Chat (Bengali)
```bash
curl -X POST http://localhost:5000/api/location/chat \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "message": "আমার কাছে কে কে আছে?",
    "lang": "bn"
  }'
```

### Example 2: Get Friend Details (English)
```bash
curl -X GET "http://localhost:5000/api/location/friend-details/65f1a2b3c4d5e6f7g8h9i0j1?lang=eng" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Example 3: Share Your Location
```bash
curl -X POST http://localhost:5000/api/location/share-location \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "lang": "bn"
  }'
```

### Example 4: Get Friends List for Chat Display
```bash
curl -X POST http://localhost:5000/api/location/chat-list-friends \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "lang": "bn"
  }'
```

---

## Features

✅ **Natural Language Processing**: Understand queries like "who is near me?", "কে কে আমার পাশে আছে?"
✅ **Bilingual Support**: Full support for Bengali and English
✅ **Distance Calculation**: Haversine formula for accurate distances
✅ **Direction Information**: Cardinal directions (N, S, E, W, etc.)
✅ **Complete Friend Profiles**: Access full friend information
✅ **Real-time Location Sharing**: Update and share locations instantly
✅ **Formatted Chat Responses**: Emoji-based, easy-to-read responses
✅ **Batch Operations**: Get multiple friends' details at once
✅ **Privacy-Safe**: Optional precision control for location data

---

## Rate Limiting
Currently no rate limiting implemented. Will be added in production.

## Security Notes
- All endpoints require authentication
- Location data is only visible to authenticated users
- Users can only see friends' locations they have access to
- Consider implementing location privacy settings

---

**Last Updated**: August 17, 2024
**API Version**: 1.0.0
