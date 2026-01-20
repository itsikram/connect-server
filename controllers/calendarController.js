const CalendarEvent = require('../models/CalendarEvent');

// Get all events for authenticated user
exports.getAllEvents = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const events = await CalendarEvent.find({ user: profileId })
            .sort({ date: 1, time: 1 });

        return res.status(200).json({
            success: true,
            events
        });
    } catch (error) {
        console.error('Error getting calendar events:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Get events for a specific date
exports.getEventsByDate = async (req, res, next) => {
    try {
        const { date } = req.query;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Date is required'
            });
        }

        const startDate = new Date(date);
        startDate.setHours(0, 0, 0, 0);
        const endDate = new Date(date);
        endDate.setHours(23, 59, 59, 999);

        const events = await CalendarEvent.find({
            user: profileId,
            date: { $gte: startDate, $lte: endDate }
        }).sort({ time: 1 });

        return res.status(200).json({
            success: true,
            events
        });
    } catch (error) {
        console.error('Error getting events by date:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Create event
exports.createEvent = async (req, res, next) => {
    try {
        const { title, date, time } = req.body;
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
                message: 'Event title is required'
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Event date is required'
            });
        }

        const event = new CalendarEvent({
            user: profileId,
            title: title.trim(),
            date: new Date(date),
            time: time || ''
        });

        const savedEvent = await event.save();

        return res.status(201).json({
            success: true,
            message: 'Event created successfully',
            event: savedEvent
        });
    } catch (error) {
        console.error('Error creating event:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update event
exports.updateEvent = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { title, date, time } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const event = await CalendarEvent.findOne({ _id: id, user: profileId });

        if (!event) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        if (title !== undefined) {
            event.title = title.trim();
        }
        if (date !== undefined) {
            event.date = new Date(date);
        }
        if (time !== undefined) {
            event.time = time;
        }

        const updatedEvent = await event.save();

        return res.status(200).json({
            success: true,
            message: 'Event updated successfully',
            event: updatedEvent
        });
    } catch (error) {
        console.error('Error updating event:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Delete event
exports.deleteEvent = async (req, res, next) => {
    try {
        const { id } = req.params;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const event = await CalendarEvent.findOne({ _id: id, user: profileId });

        if (!event) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        await CalendarEvent.deleteOne({ _id: id, user: profileId });

        return res.status(200).json({
            success: true,
            message: 'Event deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting event:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
