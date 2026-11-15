// Vercel Serverless Function entry point
// Forwards all /api/* requests to the Express application with Neon PostgreSQL
import app from '../backend/server.js';

export default app;
