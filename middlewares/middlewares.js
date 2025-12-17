const express = require("express")
const morgan = require('morgan')
const bodyParser = require('body-parser')
const cors = require('cors')
const path = require('path')

const {createProxyMiddleware} = require("http-proxy-middleware")
const middilewares = [
    morgan("dev"),
    express.static('public'),
    express.static(path.join(__dirname, "/routes/build")),
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