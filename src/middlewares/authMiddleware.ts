import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';

dotenv.config();

export const verifyToken = (req: Request, res: Response, next: NextFunction): void => {
  // Get auth header
  const authHeader = req.headers.authorization;
  
  // Check if auth header exists and has Bearer format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: "fail",
      message: "Invalid token"
    });
    return; // Return without a value after sending response
  }
  
  // Extract token (remove "Bearer " prefix)
  const token = authHeader.split(' ')[1];
  
  // Get API token from environment variables
  const API_TOKEN = process.env.API_TOKEN;
  
  // Verify token
  if (!API_TOKEN || token !== API_TOKEN) {
    res.status(401).json({
      status: "fail",
      message: "Invalid token"
    });
    return; // Return without a value after sending response
  }
  
  // If token is valid, proceed
  next();
};