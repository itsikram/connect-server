const express = require('express');
const { prisma, isDuplicate, jsonArray } = require('../utils/db');
const isAuth = require('../middlewares/isAuth');

const router = express.Router();

const getUserId = (req) => {
  const id = req.profile?.user?._id;
  return id ? String(id) : null;
};

const shapePlaylist = (row) => (row ? { ...row, items: jsonArray(row.items) } : row);

const findOwnPlaylist = (id, userId) =>
  prisma.videoPlaylist.findFirst({ where: { id: String(id), userId } });

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
    const playlists = await prisma.videoPlaylist.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    return res.json({ data: playlists.map(shapePlaylist) });
  } catch (error) {
    console.error('[VideoPlaylist] Failed to list playlists:', error);
    return res.status(500).json({ error: 'Failed to load playlists' });
  }
});

router.post('/', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });
    if (!name) return res.status(400).json({ error: 'Playlist name is required' });
    const items = cleanItems(req.body?.items);
    const playlist = await prisma.videoPlaylist.upsert({
      where: { userId_name: { userId, name } },
      update: { items },
      create: { userId, name, items },
    });
    return res.status(201).json({ data: shapePlaylist(playlist) });
  } catch (error) {
    if (isDuplicate(error)) return res.status(409).json({ error: 'A playlist with this name already exists' });
    console.error('[VideoPlaylist] Failed to save playlist:', error);
    return res.status(500).json({ error: 'Failed to save playlist' });
  }
});

router.put('/:id', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 120);
      if (!name) return res.status(400).json({ error: 'Playlist name is required' });
      updates.name = name;
    }
    if (req.body?.items !== undefined) updates.items = cleanItems(req.body.items);
    const existing = userId ? await findOwnPlaylist(req.params.id, userId) : null;
    if (!existing) return res.status(404).json({ error: 'Playlist not found' });
    const playlist = await prisma.videoPlaylist.update({ where: { id: existing.id }, data: updates });
    return res.json({ data: shapePlaylist(playlist) });
  } catch (error) {
    if (isDuplicate(error)) return res.status(409).json({ error: 'A playlist with this name already exists' });
    console.error('[VideoPlaylist] Failed to update playlist:', error);
    return res.status(500).json({ error: 'Failed to update playlist' });
  }
});

router.delete('/:id', isAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { count } = userId
      ? await prisma.videoPlaylist.deleteMany({ where: { id: String(req.params.id), userId } })
      : { count: 0 };
    if (!count) return res.status(404).json({ error: 'Playlist not found' });
    return res.json({ success: true });
  } catch (error) {
    console.error('[VideoPlaylist] Failed to delete playlist:', error);
    return res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

module.exports = router;
