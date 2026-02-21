export const createAuthMiddleware = (adminInstance) => {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization || req.headers.Authorization;
      if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        console.warn("Auth failed: missing or invalid Authorization header.");
        return res.status(401).json({ error: "Unauthorized: missing Bearer token." });
      }

      if (!adminInstance?.apps?.length) {
        console.error("Auth failed: Firebase Admin is not initialized.");
        return res.status(503).json({ error: "Authentication service unavailable." });
      }

      const token = authHeader.slice(7).trim();
      if (!token) {
        console.warn("Auth failed: empty Bearer token.");
        return res.status(401).json({ error: "Unauthorized: invalid token." });
      }

      const decoded = await adminInstance.auth().verifyIdToken(token);
      req.user = {
        uid: decoded.uid,
        email: decoded.email || null,
        name: decoded.name || null,
      };

      return next();
    } catch (error) {
      console.warn("Auth failed: token verification error.", error?.message || error);
      return res.status(401).json({ error: "Unauthorized: invalid or expired token." });
    }
  };
};
