/**
 * Entry point for the Express.js backend server.
 * This file sets up middleware, routes, and starts the server.
 */

import "./load-env.js";
import express, { json } from "express"; // Express.js framework for creating APIs
import cors from "cors"; // Middleware to enable Cross-Origin Resource Sharing
import pool from "./db.js";
import session from "express-session";
import pgSession from "connect-pg-simple";

// Importing API route handlers
import widgets from "./api/widgets.js";
import homepage from "./api/homepage.js";
import users from "./api/users.js";
import teams from "./api/teams.js";
import categories from "./api/widget-categories.js";
import developers from "./api/developers.js";
import league from "./api/league.js";
import auth from "./api/auth.js";
import teamAdmins from "./api/team-admins.js";
import games from "./api/scores.js";
import superWidget from "./api/super-widget-parameterized.js";
const SESSION_SECRET = process.env.SESSION_SECRET;

// Initialize the Express app
const app = express();

// ---------------------------------------------------
// Middleware Setup
// ---------------------------------------------------


// CORS configuration - allow frontend origins
const allowedOrigins = [
  "https://alpb-analytics.com",
  "https://www.alpb-analytics.com",
  "https://slugger-alb-1518464736.us-east-2.elb.amazonaws.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

// In development, allow any localhost/127.0.0.1 origin (for IDE browser previews)
const isLocalDevelopment = process.env.LOCAL_DEV === 'true' || process.env.NODE_ENV !== 'production';

// Add FRONTEND_URL from environment if set
if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    // In local development, allow any localhost/127.0.0.1 origin
    if (isLocalDevelopment && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return callback(null, true);
    }
    
    // Check against allowed origins list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  }
}))

/**
 * Parse incoming JSON requests.
 * Adds the parsed data to `req.body`.
 */
app.use(json());

const PostgresStore = pgSession(session);

// Create session store with error handling
const sessionStore = new PostgresStore({
  pool: pool,
  pruneSessionInterval: 60 * 15, // how often to clean up expired sessions from db (minutes)
  errorLog: (err) => {
    console.error('Session store error:', err);
    // Don't crash the server on session store errors
  }
});

// Trust proxy when running behind ALB/reverse proxy (for secure cookies)
// This allows Express to trust X-Forwarded-Proto header from the load balancer
app.set('trust proxy', 1);

// Detect environment for cookie configuration
// Use LOCAL_DEV=true to work with prod DB locally (overrides NODE_ENV)
const isProduction = process.env.NODE_ENV === 'production';
const isLocalDev = process.env.LOCAL_DEV === 'true';
const useSecureCookies = isProduction && !isLocalDev;

console.log('Environment configuration:', {
  NODE_ENV: process.env.NODE_ENV,
  LOCAL_DEV: process.env.LOCAL_DEV,
  useSecureCookies,
  DB_HOST: process.env.DB_HOST
});

// Ensure a session secret exists in production. In local development we
// allow a temporary dev secret to avoid crashing the server during local
// testing. Do NOT use the dev secret in production.
if (!SESSION_SECRET && !isLocalDevelopment) {
  console.error('SESSION_SECRET must be set in production. Exiting.');
  process.exit(1);
}
if (!SESSION_SECRET && isLocalDevelopment) {
  console.warn('SESSION_SECRET not set — using temporary development secret (unsafe for production).');
}

app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: useSecureCookies, // Secure only in true production (not local dev with prod DB)
      sameSite: useSecureCookies ? 'none' : 'lax', // 'none' only for true production
      maxAge: 24 * 60 /*minutes*/ * 60 /*seconds*/ * 1000, // session length (ms)
    },
  }),
);

// ---------------------------------------------------
// API Routes
// ---------------------------------------------------

app.use("/api/widgets", widgets);

app.use("/api/homepage", homepage);

app.use("/api/users", users);

app.use("/api/teams", teams);

app.use("/api/widget-categories", categories);

app.use("/api/developers", developers);

app.use("/api/league", league);

app.use("/api/super-widget/parameterized-analysis", superWidget);

app.use("/api/auth", auth);

app.use("/api/team-admins", teamAdmins);

app.use("/api/scores", games);

// ---------------------------------------------------
// Root Route
// ---------------------------------------------------

/**
 * Route: `/`
 * Health check route to ensure the server is running.
 */
app.get("/", (req, res) => {
  res.send("Server is running");
});

/**
 * Route: `/api/health`
 * Health check endpoint for ALB and smoke tests.
 * Returns 200 OK with server status and database connectivity.
 * Returns 503 if database is unavailable to trigger health check failure.
 */
app.get("/api/health", async (req, res) => {
  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: "unknown"
  };

  // Check database connectivity
  try {
    await pool.query('SELECT 1');
    health.database = "connected";
    res.status(200).json(health);
  } catch (error) {
    console.error('Health check: Database connection failed:', error.message);
    console.error('Database config:', {
      host: process.env.DB_HOST,
      database: process.env.DB_NAME,
      user: process.env.DB_USERNAME,
      port: process.env.DB_PORT || 5432
    });
    health.database = "disconnected";
    health.status = "unhealthy";
    health.error = error.message;
    // Return 503 Service Unavailable - triggers ALB health check failure
    res.status(503).json(health);
  }
});

// ---------------------------------------------------
// Server Initialization
// ---------------------------------------------------

/**
 * The port on which the server will run.
 * Defaults to 3001 if not specified in the environment variables.
 */
const PORT = process.env.PORT || 3001;

/**
 * Start the server and listen for incoming requests.
 */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
