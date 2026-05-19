import type { NextFunction, Request, Response } from "express";

export function makeBearerAuth(
  expected: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (header === `Bearer ${expected}`) {
      next();
      return;
    }
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };
}
