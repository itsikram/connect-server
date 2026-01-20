const Note = require('../models/Note');

// Get all notes for authenticated user
exports.getAllNotes = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const notes = await Note.find({ user: profileId })
            .sort({ updatedAt: -1 });

        return res.status(200).json({
            success: true,
            notes
        });
    } catch (error) {
        console.error('Error getting notes:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Get single note
exports.getNote = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const note = await Note.findOne({ _id: id, user: profileId });

        if (!note) {
            return res.status(404).json({
                success: false,
                message: 'Note not found'
            });
        }

        return res.status(200).json({
            success: true,
            note
        });
    } catch (error) {
        console.error('Error getting note:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Create note
exports.createNote = async (req, res, next) => {
    try {
        const { title, content } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!title || !title.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Title is required'
            });
        }

        const note = new Note({
            user: profileId,
            title: title.trim(),
            content: content || ''
        });

        const savedNote = await note.save();

        return res.status(201).json({
            success: true,
            message: 'Note created successfully',
            note: savedNote
        });
    } catch (error) {
        console.error('Error creating note:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update note
exports.updateNote = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { title, content } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const note = await Note.findOne({ _id: id, user: profileId });

        if (!note) {
            return res.status(404).json({
                success: false,
                message: 'Note not found'
            });
        }

        if (title !== undefined) {
            note.title = title.trim();
        }
        if (content !== undefined) {
            note.content = content;
        }
        note.updatedAt = Date.now();

        const updatedNote = await note.save();

        return res.status(200).json({
            success: true,
            message: 'Note updated successfully',
            note: updatedNote
        });
    } catch (error) {
        console.error('Error updating note:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete note
exports.deleteNote = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const note = await Note.findOne({ _id: id, user: profileId });

        if (!note) {
            return res.status(404).json({
                success: false,
                message: 'Note not found'
            });
        }

        await Note.deleteOne({ _id: id, user: profileId });

        return res.status(200).json({
            success: true,
            message: 'Note deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting note:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
