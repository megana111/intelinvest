import app from '../server/index.js';

// Keep every /api/* route inside one Express-backed Vercel Function.
export const config = {
  maxDuration: 300,
};

export default app;
