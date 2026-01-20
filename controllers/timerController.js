const TimerSession = require('../models/TimerSession');

// Get timer session for authenticated user
exports.getTimerSession = async (req, res, next) => {
    try {
        const profileId = req.profile?._id;
        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        let session = await TimerSession.findOne({ user: profileId });

        if (!session) {
            // Create new session if doesn't exist
            session = new TimerSession({
                user: profileId,
                completedSessions: 0
            });
            await session.save();
        }

        return res.status(200).json({
            success: true,
            session
        });
    } catch (error) {
        console.error('Error getting timer session:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update timer session (increment completed sessions)
exports.updateTimerSession = async (req, res, next) => {
    try {
        const { sessionType } = req.body;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        let session = await TimerSession.findOne({ user: profileId });

        if (!session) {
            session = new TimerSession({
                user: profileId,
                completedSessions: 0
            });
        }

        // Only increment for focus sessions
        if (sessionType === 'focus') {
            session.completedSessions += 1;
        }

        session.lastSessionType = sessionType || 'focus';
        session.lastSessionDate = new Date();

        const updatedSession = await session.save();

        return res.status(200).json({
            success: true,
            message: 'Timer session updated successfully',
            session: updatedSession
        });
    } catch (error) {
        console.error('Error updating timer session:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
