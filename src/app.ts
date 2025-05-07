import express, { Application, Request, Response, NextFunction } from "express";
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import { errorHandler } from './middlewares/errorMiddleware';
import routes from './routes';
import bodyParser from 'body-parser';
import { execSync } from 'child_process';
import path from 'path';

// Load environment variables
dotenv.config();

// Check required dependencies for Linux environment
function checkDependencies() {
  try {
    console.log('Checking required dependencies...');
    
    // Check Java version
    try {
      const javaVersion = execSync('java -version 2>&1').toString();
      console.log(`Java detected: ${javaVersion.split('\n')[0]}`);
    } catch (error) {
      console.error('❌ Java not found! Please install Java 11 or higher');
      console.error('   sudo apt update && sudo apt install openjdk-11-jdk');
    }
    
    // Check Maven version
    try {
      const mvnVersion = execSync('mvn --version').toString();
      console.log(`Maven detected: ${mvnVersion.split('\n')[0]}`);
    } catch (error) {
      console.error('❌ Maven not found! Please install Maven 3.6 or higher');
      console.error('   sudo apt update && sudo apt install maven');
    }
    
    // Check if bash exists
    try {
      execSync('which bash');
      console.log('Bash detected ✓');
    } catch (error) {
      console.error('❌ Bash not found! This is very unusual for Linux');
    }
    
    console.log('Dependency check completed');
  } catch (error) {
    console.error('Dependency check error:', error);
  }
}

// Run dependency check
checkDependencies();

// Create Express app
const app: Application = express();
const port = parseInt(process.env.PORT || "5000", 10);

// Set Maven options for better performance
process.env.MAVEN_OPTS = process.env.MAVEN_OPTS || "-Xmx1024m -XX:MaxMetaspaceSize=512m";
console.log(`Maven options: ${process.env.MAVEN_OPTS}`);

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));
app.use(cors({
  origin: process.env.CORS_ORIGINS ? 
    process.env.CORS_ORIGINS.split(',') : 
    ['http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));
app.use(helmet());
app.use(bodyParser.json({ limit: '10mb' }));

// Root route
app.get("/", (req: Request, res: Response) => {
  res.json({ 
    message: "Minecraft Plugin Generator API",
    status: "online",
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString()
  });
});

// All API routes - using a single unified router
app.use("/api", routes);

// Error handling middleware
app.use(errorHandler);

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  console.log(`http://localhost:${port}/`);
});

export default app;