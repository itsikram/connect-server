// Connects a Google account for upload storage and prints its GDRIVE_ACCOUNTS entry.
// Usage: node scripts/gdrive-auth.js <name>   (name: letters, digits, - or _)
// Requires GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env (OAuth client of type "Desktop app").
// A "Web application" client also works if http://127.0.0.1:53682 is listed as an
// authorized redirect URI (override the port with GDRIVE_AUTH_PORT).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const http = require('http')
const { exec } = require('child_process')
const { auth: driveAuth, drive: createDrive } = require('@googleapis/drive')

const name = process.argv[2]
if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    console.error('Usage: node scripts/gdrive-auth.js <name>   e.g. node scripts/gdrive-auth.js drive1')
    process.exit(1)
}

const clientId = process.env.GDRIVE_CLIENT_ID
const clientSecret = process.env.GDRIVE_CLIENT_SECRET
if (!clientId || !clientSecret) {
    console.error('Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in server/.env first.')
    process.exit(1)
}

const server = http.createServer()
const port = Number(process.env.GDRIVE_AUTH_PORT || 53682)
server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set GDRIVE_AUTH_PORT to another port.` : error.message)
    process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
    const redirectUri = `http://127.0.0.1:${server.address().port}`
    const client = new driveAuth.OAuth2(clientId, clientSecret, redirectUri)
    const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent select_account',
        scope: ['https://www.googleapis.com/auth/drive.file'],
    })

    server.on('request', async (req, res) => {
        const params = new URL(req.url, redirectUri).searchParams
        if (!params.get('code') && !params.get('error')) return res.end()
        try {
            if (params.get('error')) throw new Error(params.get('error'))
            const { tokens } = await client.getToken(params.get('code'))
            if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and try again.')
            client.setCredentials(tokens)
            const { data } = await createDrive({ version: 'v3', auth: client }).about.get({ fields: 'user(emailAddress),storageQuota' })
            const free = (Number(data.storageQuota.limit) - Number(data.storageQuota.usage)) / 1024 ** 3
            res.end('Connected. You can close this tab and return to the terminal.')
            console.log(`\nConnected ${data.user.emailAddress} (${free.toFixed(1)} GB free).`)
            console.log('Add this entry to GDRIVE_ACCOUNTS in server/.env (comma separate multiple accounts):\n')
            console.log(`${name}:${tokens.refresh_token}\n`)
        } catch (error) {
            res.end('Failed: ' + error.message)
            console.error('Failed:', error.message)
            process.exitCode = 1
        }
        server.close()
    })

    console.log(`Redirect URI: ${redirectUri}  (must be allowed for a "Web application" client)`)
    console.log(`Opening browser to sign in. If it does not open, visit:\n${url}\n`)
    const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
    exec(opener)
})
