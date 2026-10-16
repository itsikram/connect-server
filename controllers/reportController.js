const { prisma } = require('../utils/db')

const REPORT_REASONS = [
    'Spam',
    'Harassment or bullying',
    'Hate speech',
    'Violence or dangerous acts',
    'Nudity or sexual content',
    'False information',
    'Impersonation',
    'Scam or fraud',
    'Other',
]

const normalizeReason = (reason) => String(reason || '').trim()
const normalizeDetails = (details) => String(details || '').trim().slice(0, 500)

const validateReason = (reason) => {
    if (!reason) return 'Please select a reason for this report'
    if (!REPORT_REASONS.includes(reason)) return 'Please select a valid reason'
    return null
}

exports.REPORT_REASONS = REPORT_REASONS

exports.reportPost = async (req, res, next) => {
    try {
        const reporterId = req.profile._id
        const postId = req.body.postId || req.body.targetPost
        const reason = normalizeReason(req.body.reason)
        const details = normalizeDetails(req.body.details)

        if (!postId) {
            return res.status(400).json({ message: 'Post is required' })
        }

        const reasonError = validateReason(reason)
        if (reasonError) {
            return res.status(400).json({ message: reasonError })
        }

        const post = await prisma.post.findUnique({ where: { id: String(postId) }, select: { id: true, author: true } })
        if (!post) {
            return res.status(404).json({ message: 'Post not found' })
        }

        if (String(post.author) === String(reporterId)) {
            return res.status(400).json({ message: 'You cannot report your own post' })
        }

        const existing = await prisma.report.findFirst({
            where: {
                type: 'post',
                targetPost: String(postId),
                reportedBy: String(reporterId),
                status: 'open',
            },
        })
        if (existing) {
            return res.status(409).json({ message: 'You already reported this post' })
        }

        const report = await prisma.report.create({
            data: {
                type: 'post',
                targetPost: String(postId),
                reportedBy: String(reporterId),
                reason,
                details,
            },
        })

        return res.status(201).json({
            message: 'Thanks. Your report was submitted.',
            report,
        })
    } catch (error) {
        next(error)
    }
}

exports.reportProfile = async (req, res, next) => {
    try {
        const reporterId = req.profile._id
        const profileId = req.body.profileId || req.body.targetProfile || req.body.profile
        const reason = normalizeReason(req.body.reason)
        const details = normalizeDetails(req.body.details)

        if (!profileId) {
            return res.status(400).json({ message: 'Profile is required' })
        }

        const reasonError = validateReason(reason)
        if (reasonError) {
            return res.status(400).json({ message: reasonError })
        }

        const profile = await prisma.profile.findUnique({ where: { id: String(profileId) }, select: { id: true } })
        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' })
        }

        if (String(profile._id) === String(reporterId)) {
            return res.status(400).json({ message: 'You cannot report your own profile' })
        }

        const existing = await prisma.report.findFirst({
            where: {
                type: 'profile',
                targetProfile: String(profileId),
                reportedBy: String(reporterId),
                status: 'open',
            },
        })
        if (existing) {
            return res.status(409).json({ message: 'You already reported this profile' })
        }

        const report = await prisma.report.create({
            data: {
                type: 'profile',
                targetProfile: String(profileId),
                reportedBy: String(reporterId),
                reason,
                details,
            },
        })

        return res.status(201).json({
            message: 'Thanks. Your report was submitted.',
            report,
        })
    } catch (error) {
        next(error)
    }
}
