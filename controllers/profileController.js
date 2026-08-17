const Profile = require('../models/Profile')
const Post = require('../models/Post')
const Story = require('../models/Story')
const mongoose = require('mongoose')
const User = require('../models/User')


exports.prefileHasStory = async function (req, res, next) {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    let profileId = req.query.profileId
    if (mongoose.isValidObjectId(profileId)) {
        let hasStory = await Story.exists({ author: profileId, createdAt: { $gte: twentyFourHoursAgo } })
        if (hasStory == null) {
            return res.json({ 'message': 'Story Not Available', 'hasStory': 'no' }).status(200)

        } else {
            return res.json({ 'message': 'Story Available', 'hasStory': 'yes' }).status(200)

        }
    } else {
        return res.json({ 'message': 'Story Not Available', 'hasStory': 'no' }).status(400)

    }

    return next()
}
exports.getProfileImages = async function (req, res, next) {
    let { profileId } = req.query
    try {
        if (!mongoose.isValidObjectId(profileId)) return
        let profileImages = await Post.find({

            author: profileId,
            photos: {
                $ne: 'null'
            }
        })

        if(profileImages) {
            return res.json(profileImages).status(200)
        }

        return next()


    } catch (error) {
        next(error)
    }


    return next()
}

exports.profileGet = async function (req, res, next) {
    try {
        const fromQuery = req.query?.profileId;
        const fromParams = req.params?.profileId;
        const profileId = fromQuery || fromParams;
        console.log('profileGet called with id:', profileId, 'fromQuery:', fromQuery ? 'yes' : 'no');
        
        if (!profileId) {
            console.log('No profileId provided');
            return res.status(400).json({ message: 'Profile ID is required' });
        }

        console.log('Looking for profile with ID:', profileId);

        // Check if profileId is a username
        let hasUsername = await Profile.findOne({ username: profileId });
        if (hasUsername) {
            console.log('Found profile by username');
            let profileData = await Profile.findOne({ username: profileId }).populate('user');
            return res.status(200).json(profileData);
        }

        // Check if profileId is a valid ObjectId
        if (mongoose.isValidObjectId(profileId)) {
            console.log('ProfileId is valid ObjectId, searching by _id');
            let hasProfile = await Profile.findOne({ _id: profileId });
            if (!hasProfile) {
                console.log('Profile not found by _id', profileId);
                return res.status(404).json({ message: 'Profile Not Found' });
            }
            
            let profileData = await Profile.findOne({ _id: profileId }).populate(['friends', 'user']);
            
            if (profileData) {
                return res.status(200).json(profileData);
            } else {
                return res.status(404).json({ message: 'Profile data not found' });
            }
        } else {
            console.log('Invalid profile ID format:', profileId);
            return res.status(400).json({ message: 'Invalid profile ID format' });
        }
    } catch (error) {
        console.error('Error in profileGet:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
}


exports.profilePost = async (req, res, next) => {

    try {
        let profileId = req.body.profile
        if (profileId == false) return;

        if (mongoose.isValidObjectId(profileId)) {
            let hasProfile = await Profile.exists({ _id: profileId })
            if (!hasProfile) return res.json({ message: 'Profile Not Found' }).status(404)
            let profileData = await Profile.findOne({ _id: profileId }).populate(['friends', 'user'])
            if (profileData) {
                return res.json(profileData)
            }
        }


    } catch (error) {
        next(error)
    }

}
exports.updateCoverPost = async (req, res, next) => {

    let profileId = req.body.profile
    let coverPicUrl = req.body.coverPicUrl
    try {
        let updateProfile = await Profile.findOneAndUpdate({ _id: profileId }, {
            coverPic: coverPicUrl
        })
        res.json(updateProfile)




    } catch (error) {
        console.log(error)
    }


}

exports.updateProfilePic = async (req, res, next) => {
    let profileId = req.profile._id;
    let profilePicUrl = req.body.profilePicUrl
    let caption = req.body.caption
    let type = req.body.type || 'post'


    try {

        let post = new Post({
            type,
            caption,
            photos: profilePicUrl,
            author: profileId
        })

        let savedPost = await post.save()

        let updatedProfile = await Profile.findByIdAndUpdate({ _id: profileId }, {
            profilePic: profilePicUrl
        }, { new: true })

        if (savedPost && updatedProfile) {
            return res.json(updatedProfile)
        }

    } catch (error) {
        console.log(error)
    }
}

exports.updateBioPost = async (req, res, next) => {
    try {

        let bio = req.body.bio
        let updateProfile = await Profile.findByIdAndUpdate({
            _id: req.profile._id
        }, {
            bio
        }, { new: true })

        if (updateProfile) {
            res.json(updateProfile)
        }

    } catch (error) {
        console.log(error)
    }


}
exports.updateProfile = async (req, res, next) => {
    try {
        let reqData = { ...req.body }

        if (req.body.firstName && req.body.surname) {

            reqData.fullName = req.body.firstName + ' ' + req.body.surname

            let updatedUser = await User.findOneAndUpdate({ _id: req.profile.user }, {
                firstName: req.body.firstName,
                surname: req.body.surname
            }, { new: true })

        }


        let updateProfile = await Profile.findByIdAndUpdate({
            _id: req.profile._id
        }, {
            ...reqData
        }, { new: true }).populate('user')

        if (updateProfile) {
            res.json(updateProfile)
        }

    } catch (error) {
        console.log(error)
    }


}

// Get nearby profiles based on location
exports.getNearbyProfiles = async (req, res, next) => {
    try {
        const { latitude, longitude, radius = 50, profileId } = req.query;

        // Validate required parameters
        if (!latitude || !longitude) {
            return res.status(400).json({ 
                message: 'Latitude and longitude are required' 
            });
        }

        const userLat = parseFloat(latitude);
        const userLng = parseFloat(longitude);
        const maxRadius = parseFloat(radius); // in kilometers

        if (isNaN(userLat) || isNaN(userLng) || isNaN(maxRadius)) {
            return res.status(400).json({ 
                message: 'Invalid latitude, longitude, or radius values' 
            });
        }

        // Get current user's friends list if profileId is provided
        let userFriends = [];
        if (profileId) {
            try {
                const currentUser = await Profile.findById(profileId).select('friends');
                if (currentUser && currentUser.friends) {
                    userFriends = currentUser.friends.map(fid => String(fid));
                }
            } catch (err) {
                console.warn('Error fetching current user friends:', err);
            }
        }

        // Find all profiles with valid locations
        const allProfiles = await Profile.find({
            'lastLocation.latitude': { $exists: true, $ne: null, $ne: 0 },
            'lastLocation.longitude': { $exists: true, $ne: null, $ne: 0 }
        }).select('_id fullName displayName profilePic username bio lastLocation');

        // Calculate distance for each profile and filter by radius
        const nearbyProfiles = [];
        
        for (const profile of allProfiles) {
            // Skip current user if profileId is provided
            if (profileId && String(profile._id) === String(profileId)) {
                continue;
            }

            const profileLat = profile.lastLocation.latitude;
            const profileLng = profile.lastLocation.longitude;

            // Calculate distance using Haversine formula
            const R = 6371; // Earth's radius in km
            const dLat = (profileLat - userLat) * Math.PI / 180;
            const dLng = (profileLng - userLng) * Math.PI / 180;
            const a = 
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(userLat * Math.PI / 180) * Math.cos(profileLat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const distance = R * c;

            // Only include profiles within the radius
            if (distance <= maxRadius) {
                const profileIdStr = String(profile._id);
                nearbyProfiles.push({
                    _id: profile._id,
                    fullName: profile.fullName || profile.displayName || 'User',
                    displayName: profile.displayName,
                    profilePic: profile.profilePic,
                    username: profile.username,
                    bio: profile.bio,
                    lastLocation: {
                        latitude: profileLat,
                        longitude: profileLng,
                        timestamp: profile.lastLocation.timestamp
                    },
                    distance: parseFloat(distance.toFixed(2)),
                    isFriend: userFriends.includes(profileIdStr)
                });
            }
        }

        // Sort by distance (nearest first)
        nearbyProfiles.sort((a, b) => a.distance - b.distance);

        console.log(`📍 Found ${nearbyProfiles.length} nearby profiles within ${maxRadius}km`);

        return res.status(200).json({
            success: true,
            count: nearbyProfiles.length,
            profiles: nearbyProfiles
        });

    } catch (error) {
        console.error('Error in getNearbyProfiles:', error);
        return res.status(500).json({ 
            message: 'Internal server error',
            error: error.message 
        });
    }
}

// HTTP-based online status checking
exports.getOnlineStatus = async (req, res, next) => {
    try {
        const { profileId, myId } = req.query;
        
        if (!profileId) {
            return res.status(400).json({ isActive: false, lastSeen: null });
        }
        
        const profile = await Profile.findById(profileId);
        
        if (!profile) {
            return res.status(404).json({ isActive: false, lastSeen: null });
        }
        
        const now = new Date();
        const lastActive = profile.lastActive ? new Date(profile.lastActive) : null;
        const isActive = lastActive && (now - lastActive) < 5 * 60 * 1000; // Active if last seen within 5 minutes
        
        return res.status(200).json({
            isActive,
            lastSeen: lastActive
        });
        
    } catch (error) {
        console.error('Error checking online status:', error);
        return res.status(500).json({ isActive: false, lastSeen: null });
    }
};

exports.getNearbyPlaces = async (req, res, next) => {
    try {
        const { latitude, longitude, radius = 2000 } = req.query;

        // Validate required parameters
        if (!latitude || !longitude) {
            return res.status(400).json({ 
                message: 'Latitude and longitude are required' 
            });
        }

        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);
        const rad = parseInt(radius);

        // Validate coordinates
        if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            return res.status(400).json({ 
                message: 'Invalid latitude or longitude values' 
            });
        }

        const PLACE_TYPES = ['restaurant', 'cafe', 'park'];
        const mapPlaceTypeToOverpassTag = (type) => {
            switch (type) {
                case 'restaurant':
                    return '["amenity"="restaurant"]';
                case 'cafe':
                    return '["amenity"="cafe"]';
                case 'park':
                    return '["leisure"="park"]';
                default:
                    return '';
            }
        };

        const aroundClauses = PLACE_TYPES.map((type) => {
            const tag = mapPlaceTypeToOverpassTag(type);
            return `
                node${tag}(around:${rad},${lat},${lng});
                way${tag}(around:${rad},${lat},${lng});
                relation${tag}(around:${rad},${lat},${lng});
            `;
        }).join('\n');

        const query = `
            [out:json][timeout:15];
            (
                ${aroundClauses}
            );
            out center tags;
        `;

        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
            },
            body: query,
            timeout: 20000,
        });

        if (!response.ok) {
            throw new Error(`Overpass API request failed with status ${response.status}`);
        }

        const data = await response.json();
        const seenPlaceIds = new Set();
        const places = [];

        (data.elements || []).forEach((place) => {
            const placeLat = place.lat ?? place.center?.lat;
            const placeLng = place.lon ?? place.center?.lon;
            if (typeof placeLat !== 'number' || typeof placeLng !== 'number') return;

            const placeKey = `${place.type}-${place.id}`;
            if (seenPlaceIds.has(placeKey)) return;
            seenPlaceIds.add(placeKey);

            const name = place.tags?.name || place.tags?.brand || 'Place';
            const address = [
                place.tags?.['addr:housenumber'],
                place.tags?.['addr:street'],
            ]
                .filter(Boolean)
                .join(' ');
            const category = place.tags?.amenity || place.tags?.leisure || place.tags?.tourism || '';

            places.push({
                id: place.id,
                type: place.type,
                lat: placeLat,
                lng: placeLng,
                name,
                address,
                category,
            });
        });

        return res.status(200).json({
            success: true,
            places,
            count: places.length,
        });
    } catch (error) {
        console.error('Error fetching nearby places:', error);
        return res.status(500).json({ 
            message: 'Failed to fetch nearby places',
            error: error.message 
        });
    }
};




