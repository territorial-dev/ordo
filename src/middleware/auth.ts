import { Request, Response, NextFunction } from "express";
import { authenticateKey, touchApiKey } from "../services/apiKeyService";
import { AuthContext, Role } from "../types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Bearer authentication. The environment API_TOKEN is the installation's admin key;
 * every other token is looked up (hashed) in api_key and carries its role.
 */
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.substring(7);
  const expectedToken = process.env.API_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: "Server configuration error" });
    return;
  }

  if (token === expectedToken) {
    req.auth = { role: "admin", keyId: null, keyName: "API_TOKEN" };
    next();
    return;
  }

  try {
    const key = await authenticateKey(token);
    if (!key) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }
    touchApiKey(key.id);
    req.auth = { role: key.role, keyId: key.id, keyName: key.name };
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/** Allows the listed roles; admin always passes. */
export const requireRole = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.auth?.role;
    if (role === "admin" || (role && roles.includes(role))) {
      next();
      return;
    }
    res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
  };
};
