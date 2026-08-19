const express = require("express")
const morgan = require('morgan')
const bodyParser = require('body-parser')
const cors = require('cors')
const path = require('path')

const {createProxyMiddleware} = require("http-proxy-middleware")

// Global request logging intentionally disabled to keep debug.log focused on Ludo state only.
const noCacheForLocalhost = (req, res, next) => {
    const hostname = req.hostname || req.get('host')?.split(':')[0];
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    
    if (isLocalhost) {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
    }
    next();
};

const middilewares = [
    morgan("dev"),
    noCacheForLocalhost, // Add no-cache headers for localhost before static files
    express.static('public', { 
        setHeaders: (res, path) => {
            const hostname = require('url').parse(path).hostname || 'localhost';
            const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
            if (isLocalhost) {
                res.set({
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
            }
        }
    }),
    express.static(path.join(__dirname, "/routes/build"), {
        setHeaders: (res, path) => {
            const hostname = require('url').parse(path).hostname || 'localhost';
            const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
            if (isLocalhost) {
                res.set({
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                });
            }
        }
    }),
    bodyParser.urlencoded({extended: true, limit: '10mb'}),
    bodyParser.json({limit: '10mb'}), // Increased limit for base64 image payloads (emotion detection)
    cors({
        origin: '*',
        
    })

]

module.exports = app => {
    middilewares.forEach(m => {
        app.use(m)
    })
    
}