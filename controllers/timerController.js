const { prisma } = require('../utils/db');

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

        let session = await prisma.timerSession.findFirst({ where: { user: String(profileId) } });

        if (!session) {
            // Create new session if doesn't exist
            session = await prisma.timerSession.create({
                data: { user: String(profileId), completedSessions: 0 }
            });
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

        let session = await prisma.timerSession.findFirst({ where: { user: String(profileId) } });

        if (!session) {
            session = await prisma.timerSession.create({
                data: { user: String(profileId), completedSessions: 0 }
            });
        }

        const updatedSession = await prisma.timerSession.update({
            where: { id: session.id },
            data: {
                // Only increment for focus sessions
                ...(sessionType === 'focus' ? { completedSessions: { increment: 1 } } : {}),
                lastSessionType: sessionType || 'focus',
                lastSessionDate: new Date()
            }
        });

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
