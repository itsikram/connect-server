const { prisma, jsonObject } = require('../utils/db');

const findOwnHabit = (id, profileId) =>
    prisma.habit.findFirst({ where: { id: String(id), user: String(profileId) } });

// records was a Mongoose Map<"YYYY-MM-DD", Boolean>; now a Json object.
const shapeHabit = (habit) => (habit ? { ...habit, records: jsonObject(habit.records) } : habit);

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

        const habits = (await prisma.habit.findMany({
            where: { user: String(profileId) },
            orderBy: { createdAt: 'desc' }
        })).map(shapeHabit);

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

        const habit = await findOwnHabit(id, profileId);

        if (!habit) {
            return res.status(404).json({
                success: false,
                message: 'Habit not found'
            });
        }

        return res.status(200).json({
            success: true,
            habit: shapeHabit(habit)
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

        const savedHabit = shapeHabit(await prisma.habit.create({
            data: {
                user: String(profileId),
                name: name.trim(),
                color: color || '#22C55E',
                streak: 0,
                longestStreak: 0,
                records: {}
            }
        }));

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

        const habit = await findOwnHabit(id, profileId);

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
            const recordsObj = {};
            Object.keys(records || {}).forEach(key => {
                recordsObj[key] = Boolean(records[key]);
            });
            habit.records = recordsObj;
        }
        if (streak !== undefined) {
            habit.streak = streak;
        }
        if (longestStreak !== undefined) {
            habit.longestStreak = longestStreak;
        }

        const updatedHabit = shapeHabit(await prisma.habit.update({
            where: { id: habit.id },
            data: {
                name: habit.name,
                color: habit.color,
                records: jsonObject(habit.records),
                streak: Number(habit.streak) || 0,
                longestStreak: Number(habit.longestStreak) || 0
            }
        }));

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

        const habit = await findOwnHabit(id, profileId);

        if (!habit) {
            return res.status(404).json({
                success: false,
                message: 'Habit not found'
            });
        }

        await prisma.habit.delete({ where: { id: habit.id } });

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
