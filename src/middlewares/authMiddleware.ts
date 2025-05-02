import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Get API token from environment variables
const API_TOKEN = process.env.API_TOKEN || 'your-secret-token';

export const verifyToken = (req: Request, res: Response, next: NextFunction): void => {
  // Get auth header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 'fail',
      message: 'Authentication required. Please provide a valid Bearer token.'
    });
    return;
  }
  
  // Extract the token
  const token = authHeader.split(' ')[1];
  
  // Simple token validation (use JWT verify in production)
  if (token !== API_TOKEN) {
    res.status(401).json({
      status: 'fail',
      message: 'Invalid token'
    });
    return;
  }
  
  next();
};