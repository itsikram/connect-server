const { prisma } = require('./db');

// GoDaddy uses the same lazy table creation convention as secure messages.
let ready;
module.exports = () => {
    if (!ready) {
        ready = (async () => {
            const charset = 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci';
            await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS personal_drive_connections (
                id VARCHAR(64) PRIMARY KEY,
                googleSubject VARCHAR(255) NOT NULL,
                email VARCHAR(320) NOT NULL,
                refreshToken TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT TRUE
            ) ${charset}`);
            await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS personal_drive_consents (
                id VARCHAR(64) PRIMARY KEY,
                owner VARCHAR(64) NOT NULL,
                verifier VARCHAR(128) NOT NULL,
                expiresAt DATETIME(3) NOT NULL,
                INDEX personal_drive_consents_owner_idx (owner),
                INDEX personal_drive_consents_expiresAt_idx (expiresAt)
            ) ${charset}`);
            await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS personal_drive_files (
                id VARCHAR(32) PRIMARY KEY,
                owner VARCHAR(64) NOT NULL,
                recipient VARCHAR(64) NOT NULL,
                googleSubject VARCHAR(255) NOT NULL,
                driveId VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                mime VARCHAR(64) NOT NULL,
                kind VARCHAR(16) NOT NULL
            ) ${charset}`);
        })().catch((error) => {
            ready = null;
            throw error;
        });
    }
    return ready;
};
