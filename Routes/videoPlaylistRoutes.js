const express = require('express');
const VideoPlaylist = require('../models/VideoPlaylist');
const isAuth = require('../middlewares/isAuth');

const router = express.Router();

const getUserId = (req) => req.profile?.user?._id;

const cleanItems = (items) => (Array.isArray(items) ? items : [])
  .filter((item) => item && item.url && item.videoId && item.queueId)
  .slice(0, 500)
  .map((item) => ({
    queueId: String(item.queueId),
    videoId: String(item.videoId),
    url: String(item.url),
    title: String(item.title || 'Untitled video').slice(0, 300),
    thumbnail: String(item.thumbnail || ''),
    type: String(item.type || 'url'),
    playCount: Math.min(99, Math.max(1, Number(item.playCount) || 1)),
  }));

router.get('/', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    const playlists = await VideoPlaylist.find({ userId }).sort({ updatedAt: -1 }).lean();
    return res.json({ data: playlists });
  } catch (error) {
    console.error('[VideoPlaylist] Failed to list playlists:', error);
    return res.status(500).json({ error: 'Failed to load playlists' });
  }
});

router.post('/', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const name = String(req.body?.name || '').trim();
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    if (!name) return res.status(400).json({ error: 'Playlist name is required' });
    const playlist = await VideoPlaylist.findOneAndUpdate(
      { userId, name },
      { userId, name, items: cleanItems(req.body?.items) },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();
    return res.status(201).json({ data: playlist });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'A playlist with this name already exists' });
    console.error('[VideoPlaylist] Failed to save playlist:', error);
    return res.status(500).json({ error: 'Failed to save playlist' });
  }
});

router.put('/:id', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Playlist name is required' });
      updates.name = name;
    }
    if (req.body?.items !== undefined) updates.items = cleanItems(req.body.items);
    const playlist = await VideoPlaylist.findOneAndUpdate(
      { _id: req.params.id, userId },
      updates,
      { new: true, runValidators: true },
    ).lean();
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    return res.json({ data: playlist });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'A playlist with this name already exists' });
    console.error('[VideoPlaylist] Failed to update playlist:', error);
    return res.status(500).json({ error: 'Failed to update playlist' });
  }
});

router.delete('/:id', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const deleted = await VideoPlaylist.findOneAndDelete({ _id: req.params.id, userId });
    if (!deleted) return res.status(404).json({ error: 'Playlist not found' });
    return res.json({ success: true });
  } catch (error) {
    console.error('[VideoPlaylist] Failed to delete playlist:', error);
    return res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

module.exports = router;
