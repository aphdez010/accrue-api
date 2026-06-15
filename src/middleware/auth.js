import { getAuth, clerkMiddleware } from '@clerk/express';

export const initClerk = clerkMiddleware({
  authorizedParties: ['https://supervisd.com', 'http://localhost:3010'],
});

export function requireAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.auth = { userId };
  next();
}