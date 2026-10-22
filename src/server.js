const dotenv = require('dotenv');

dotenv.config();

const { createApp } = require('./app');
const { createPlatformAuth } = require('./middleware/platformAuth');

const PORT = process.env.PORT || 5000;

const platformAuth = createPlatformAuth({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  authorizedParties: process.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((origin) => origin.trim()).filter(Boolean)
});

if (!process.env.CLERK_SECRET_KEY) {
  console.warn('[platform] CLERK_SECRET_KEY is not set: /api/platform responds 503 until it is.');
}

createApp({ platformAuth }).listen(PORT, () => {
  console.log(`[Shenaly Rent a Car] Backend server running on port ${PORT}`);
});
