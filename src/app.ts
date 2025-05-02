import express, { Application, Request, Response, NextFunction } from "express";
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import { errorHandler } from './middlewares/errorMiddleware';
import routes from './routes';

// Load environment variables
dotenv.config();

// Create Express app
const app: Application = express();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));
app.use(cors());
app.use(helmet());

// Root route
app.get("/", (req: Request, res: Response) => {
  res.json({ message: "Welcome to the API" });
});

// All API routes
app.use("/api", routes);

// Error handling middleware
app.use(errorHandler);

export default app;