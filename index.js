

require('dotenv').config();
const express = require('express')
const PORT = process.env.PORT || 4000;
const mongoose = require('mongoose')
const MONGODB_URI = process.env.NODE_ENV == 'production' ? process.env.PROD_MONGODB_URI : process.env.DEV_MONGODB_URI;
mongoose.set('strictQuery', false)
mongoose.set('strictPopulate', false);
const socketIo = require('socket.io');
const { createServer } = require('http')
const cors = require('cors');
const middilewares = require('./middlewares/middlewares')
const routes = require('./Routes/routes');
const agoraRoutes = require('./Routes/agoraRoutes');
let app = express();
const socketHandler = require('./sockets/socketHandler')
const httpServer = createServer(app)
const path = require('path');

// Enable pre-flight requests
app.options('*', cors());

// Configure CORS
app.use(cors({
  origin: true, // Allow all origins temporarily for debugging
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Range', 'X-Content-Range']
}));

// Additional headers for CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  if ('OPTIONS' === req.method) {
    res.sendStatus(200);
  } else {
    next();
  }
});

const io = socketIo(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
  },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: '/socket.io',
  cookie: false
});

socketHandler(io)

// Setting up middilewares
middilewares(app)

// setting up routes
routes(app)

// setup Agora routes
app.use('/api/agora', agoraRoutes);


app.set('io',io)

app.use(express.static(path.join(__dirname, 'build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// app.get('/', async (req, res) => {
//   return res.json({ message: 'workign fine' });
// })

// Root route should serve index.html

mongoose.connect(process.env.PROD_MONGODB_URI, {}).then(async(e) => {

  httpServer.listen(PORT, (e) => {
    console.log(`Server is running on port ${PORT}`)
  })
}).catch(e => {
  console.log(e)
})




