const Habit = require('../models/Habit');

// Get all habits for authenticated user
exports.getAllHabits = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const habits = await Habit.find({ user: profileId })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            habits
        });
    } catch (error) {
        console.error('Error getting habits:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Get single habit
exports.getHabit = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const habit = await Habit.findOne({ _id: id, user: profileId });

        if (!habit) {
            return res.status(404).json({
                success: false,
                message: 'Habit not found'
            });
        }

        return res.status(200).json({
            success: true,
            habit
        });
    } catch (error) {
        console.error('Error getting habit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Create habit
exports.createHabit = async (req, res, next) => {
    try {
        const { name, color } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Habit name is required'
            });
        }

        const habit = new Habit({
            user: profileId,
            name: name.trim(),
            color: color || '#22C55E',
            streak: 0,
            longestStreak: 0,
            records: new Map()
        });

        const savedHabit = await habit.save();

        return res.status(201).json({
            success: true,
            message: 'Habit created successfully',
            habit: savedHabit
        });
    } catch (error) {
        console.error('Error creating habit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update habit (toggle record, update streak, etc.)
exports.updateHabit = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, color, records, streak, longestStreak } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const habit = await Habit.findOne({ _id: id, user: profileId });

        if (!habit) {
            return res.status(404).json({
                success: false,
                message: 'Habit not found'
            });
        }

        if (name !== undefined) {
            habit.name = name.trim();
        }
        if (color !== undefined) {
            habit.color = color;
        }
        if (records !== undefined) {
            // Convert records object to Map
            const recordsMap = new Map();
            Object.keys(records).forEach(key => {
                recordsMap.set(key, records[key]);
            });
            habit.records = recordsMap;
        }
        if (streak !== undefined) {
            habit.streak = streak;
        }
        if (longestStreak !== undefined) {
            habit.longestStreak = longestStreak;
        }
        habit.updatedAt = Date.now();

        const updatedHabit = await habit.save();

        return res.status(200).json({
            success: true,
            message: 'Habit updated successfully',
            habit: updatedHabit
        });
    } catch (error) {
        console.error('Error updating habit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete habit
exports.deleteHabit = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const habit = await Habit.findOne({ _id: id, user: profileId });

        if (!habit) {
            return res.status(404).json({
                success: false,
                message: 'Habit not found'
            });
        }

        await Habit.deleteOne({ _id: id, user: profileId });

        return res.status(200).json({
            success: true,
            message: 'Habit deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting habit:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
