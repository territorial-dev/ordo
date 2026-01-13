import { Request, Response, NextFunction } from 'express';

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const expectedToken = process.env.API_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  if (token !== expectedToken) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  next();
};
