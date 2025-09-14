const {Schema,model} = require('mongoose')
let connectSchema = new Schema({
    siteLogo: {
        type: String,
        trim: true,
    },
    siteTitle: {
        type: String,
        trim: true,
    },
    siteUrl: {
        type: String,
        trim: true,
    },
    siteDescription: {
        type: String,
        trim: true,
    },
    
    showAds: Boolean,
    registerNewAccount: Boolean,
    defaultTheme: {
        type: String,
        default: 'dark'
    },
    defaultLanguage: {
        type: String,
        default: 'en'
    },
    defaultTimezone: {
        type: String,
        default: 'UTC'
    },
    isMaintenanceMode: Boolean,
    
},{timestamps: true})

let Connect = model('Connect',connectSchema)

module.exports = Connect
