const Task = require('../models/Task');

// Get all tasks for authenticated user
exports.getAllTasks = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const tasks = await Task.find({ user: profileId })
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            tasks
        });
    } catch (error) {
        console.error('Error getting tasks:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Create task
exports.createTask = async (req, res, next) => {
    try {
        const { text } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!text || !text.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Task text is required'
            });
        }

        const task = new Task({
            user: profileId,
            text: text.trim(),
            completed: false
        });

        const savedTask = await task.save();

        return res.status(201).json({
            success: true,
            message: 'Task created successfully',
            task: savedTask
        });
    } catch (error) {
        console.error('Error creating task:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update task
exports.updateTask = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { text, completed } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const task = await Task.findOne({ _id: id, user: profileId });

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Task not found'
            });
        }

        if (text !== undefined) {
            task.text = text.trim();
        }
        if (completed !== undefined) {
            task.completed = completed;
        }

        const updatedTask = await task.save();

        return res.status(200).json({
            success: true,
            message: 'Task updated successfully',
            task: updatedTask
        });
    } catch (error) {
        console.error('Error updating task:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete task
exports.deleteTask = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const task = await Task.findOne({ _id: id, user: profileId });

        if (!task) {
            return res.status(404).json({
                success: false,
                message: 'Task not found'
            });
        }

        await Task.deleteOne({ _id: id, user: profileId });

        return res.status(200).json({
            success: true,
            message: 'Task deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting task:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete all completed tasks
exports.deleteCompletedTasks = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const result = await Task.deleteMany({ user: profileId, completed: true });

        return res.status(200).json({
            success: true,
            message: 'Completed tasks deleted successfully',
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error deleting completed tasks:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
