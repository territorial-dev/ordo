import { Request, Response } from "express";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  ROLES,
} from "../services/apiKeyService";
import { Role } from "../types";

export const createKeyHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { name, role } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    if (!ROLES.includes(role as Role)) {
      res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
      return;
    }
    const created = await createApiKey(name, role as Role);
    res.status(201).json(created);
  } catch (error) {
    console.error("Error creating key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const listKeysHandler = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    res.json(await listApiKeys());
  } catch (error) {
    console.error("Error listing keys:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const revokeKeyHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid key ID" });
      return;
    }
    const revoked = await revokeApiKey(id);
    if (!revoked) {
      res.status(404).json({ error: "Key not found or already revoked" });
      return;
    }
    res.json({ id, revoked: true });
  } catch (error) {
    console.error("Error revoking key:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
