# Location API - Quick Start Guide

## Setup

The location API is now integrated into the Connect server. All files are in place:

### Files Created
```
server/
├── services/ai/
│   ├── locationService.js         # Core location calculations
│   └── chatLocationService.js      # AI chat processing
├── controllers/
│   ├── locationController.js       # API endpoints
│   └── chatLocationController.js   # Chat endpoints
├── Routes/
│   └── locationRoutes.js           # Route definitions
├── utils/localization/
│   └── translations.js             # Bengali & English translations
└── utils/
    └── locationHelper.js           # Helper utilities
```

## Testing the API

### 1. Share Your Location
First, share your current location:

```bash
curl -X POST http://localhost:5000/api/location/share-location \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "lang": "bn"
  }'
```

### 2. Chat About Friend Locations

**Bengali Example:**
```bash
curl -X POST http://localhost:5000/api/location/chat \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "message": "আমার কাছে কে কে আছে?",
    "lang": "bn"
  }'
```

**English Example:**
```bash
curl -X POST http://localhost:5000/api/location/chat \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "message": "Who is near me?",
    "lang": "eng"
  }'
```

### 3. Get Complete Friend Details

```bash
curl -X GET "http://localhost:5000/api/location/friend-details/FRIEND_ID?lang=bn" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response includes:
- Personal information (name, email, bio)
- Current location (latitude, longitude)
- Present and permanent addresses
- Workplace information
- Education history
- Active status and mood

### 4. Get Friends List for Chat

```bash
curl -X POST http://localhost:5000/api/location/chat-list-friends \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 23.8103,
    "longitude": 90.4125,
    "lang": "bn"
  }'
```

Responses include emoji-based indicators:
- 🔴 Very Close (< 0.5 km)
- 🟠 Close (< 2 km)
- 🟡 Nearby (< 10 km)
- 🟢 Moderate Distance (< 50 km)
- 🔵 Far (> 50 km)
- ❓ No Location Shared

## API Endpoints Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/location/chat` | Chat about friend locations |
| `GET` | `/api/location/friend-details/:friendId` | Get complete friend details |
| `POST` | `/api/location/bulk-friend-details` | Get multiple friends' details |
| `POST` | `/api/location/chat-list-friends` | Get formatted friends list |
| `POST` | `/api/location/share-location` | Update your location |
| `GET` | `/api/location/friends-nearby` | Get nearby friends (structured) |
| `GET` | `/api/location/friend/:friendId` | Get specific friend location |

## Language Support

### Bengali (bn)
- Messages in Bengali
- Bengali formatting and emojis
- Example: "আমার কাছে কে কে আছে?"

### English (eng) - Default
- Messages in English
- English formatting
- Example: "Who is near me?"

## Response Format

### Chat Response Example (Bengali)

```json
{
  "success": true,
  "greeting": "চমৎকার! আমি আপনার কাছে 2 জন বন্ধু খুঁজে পেয়েছি।",
  "summary": "📊 **সংক্ষিপ্ত বিবরণ:**\n- মোট বন্ধু: 5\n- কাছাকাছি: 2\n- অবস্থান শেয়ার করেছেন: 4",
  "message": "👥 **কাছাকাছি বন্ধুদের বিস্তারিত:**\n\n🥇 **রহিম সাহেব**\n   📏 দূরত্ব: 1.25 কিমি\n   🧭 দিক: উত্তর-পূর্ব\n   📌 ঠিকানা: ঢাকা, বাংলাদেশ\n   🟢 সক্রিয়",
  "friends": [
    {
      "name": "রহিম সাহেব",
      "distance": "1.25 km",
      "direction": "উত্তর-পূর্ব",
      "address": "ঢাকা, বাংলাদেশ"
    }
  ],
  "totalNearby": 2,
  "language": "bn"
}
```

## Integration with Chat Interface

The API can be integrated into your chat interface:

```javascript
// Send chat message about location
async function askAboutFriendLocations(latitude, longitude, message, language) {
  const response = await fetch('/api/location/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      latitude,
      longitude,
      message,
      lang: language
    })
  });
  
  const data = await response.json();
  return data.message; // Display this in chat
}

// Get friend details
async function getFriendInfo(friendId, language) {
  const response = await fetch(`/api/location/friend-details/${friendId}?lang=${language}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await response.json();
  return data.message; // Display detailed info
}

// Get friends list
async function getChatFriendsList(latitude, longitude, language) {
  const response = await fetch('/api/location/chat-list-friends', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      latitude,
      longitude,
      lang: language
    })
  });
  
  const data = await response.json();
  return data; // Use for displaying formatted list
}
```

## Natural Language Queries

The API understands these types of queries:

**Distance-based**:
- "কে কে আমার খুব কাছে আছে?" → Shows friends < 2 km
- "Who is nearby?" → Shows friends < 50 km
- "আমার দূরের বন্ধুরা কোথায়?" → Shows friends > 50 km

**Information requests**:
- "আমার বন্ধুরা কোথায়?" → All friends with locations
- "Where are my friends?" → Complete friend list
- "আমার কাছে কে আছে?" → Friends nearby

**Single friend queries**:
- "রহিম কোথায়?" → Specific friend location
- "Where is Rahim?" → Friend's exact location

## Error Handling

### Common Errors

**Missing Coordinates**:
```json
{
  "error": true,
  "message": "অবস্থান স্থানাঙ্ক এবং বার্তা প্রয়োজন।",
  "code": "MISSING_COORDINATES"
}
```

**Unauthorized**:
```json
{
  "error": true,
  "message": "You are not authorized to access this resource.",
  "code": "UNAUTHORIZED"
}
```

**Invalid Location**:
```json
{
  "error": true,
  "message": "Invalid location coordinates provided.",
  "code": "INVALID_LOCATION"
}
```

## Privacy Considerations

- Users can only see friends' locations they are connected with
- Location data is stored with timestamps
- Coordinates can be rounded for privacy (via helpers)
- Users can opt-out of location sharing via profile settings

## Performance Tips

1. **Cache friend lists**: Reduce API calls by caching friend data
2. **Batch requests**: Use `/bulk-friend-details` for multiple friends
3. **Update intervals**: Share location every 5-10 minutes for real-time tracking
4. **Filter results**: Use radius parameter to limit data returned

## Troubleshooting

**No friends found**:
- Ensure friends have location enabled
- Check if you're actually connected as friends
- Verify location coordinates are valid

**Invalid token**:
- Refresh your authentication token
- Ensure Bearer token is properly formatted

**Coordinates out of range**:
- Latitude must be -90 to 90
- Longitude must be -180 to 180

## Next Steps

1. Test the endpoints with curl or Postman
2. Integrate chat endpoints into your UI
3. Implement real-time location sharing
4. Add location privacy settings
5. Create location-based notifications

---

**For detailed API documentation**, see `LOCATION_CHAT_API.md`
