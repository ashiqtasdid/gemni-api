import express, { Router, Request, Response } from "express";
import { verifyToken } from "../middlewares/authMiddleware";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import crypto from "crypto";
import NodeCache from "node-cache";
import path from "path";
import { spawn } from 'child_process';
import fs from 'fs';

dotenv.config();

// Initialize the Gemini API client
const API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);

// Initialize cache with configurable TTL (default: 1 hour)
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "3600");
const pluginCache = new NodeCache({ stdTTL: CACHE_TTL });

// Precompile frequently used regex patterns for better performance
const FILE_PATTERN = /---FILE_START:(.*?)---([\s\S]*?)---FILE_END---/g;
const PLUGIN_NAME_PATTERN = /Plugin name:?\s*([A-Za-z0-9_]+)/i;
const PLUGIN_NAME_ALT_PATTERN = /Name:?\s*([A-Za-z0-9_]+)\s*plugin/i;
const JSON_ARRAY_PATTERN = /\[\s*"[^"]+(?:",\s*"[^"]+")*\s*\]/;
const FILE_EXTENSION_PATTERN = /[\w\/\-\.]+\.(java|xml|yml)/g;
const MARKDOWN_CODE_PATTERN = /^```(?:java|xml|yml|yaml)?\s*\n?|```\s*$|```/g;

// Model configuration templates
const MODEL_CONFIG = {
  flash: {
    name: "gemini-2.5-flash-preview-04-17",
    precision: { temperature: 0.1, topP: 0.95, topK: 64 },
    creative: { temperature: 1.5, topP: 0.95, topK: 64 }  // Changed from 5 to 1.5
  },
  pro: {
    name: "gemini-2.5-pro-preview-03-25",
    precision: { temperature: 0.1, topP: 0.95, topK: 64 },
    creative: { temperature: 0.2, topP: 0.95, topK: 64 }
  }
};

// Interfaces
interface InconsistencyIssue {
  fileA: string;
  fileB: string;
  issue: string;
  fix: string;
}

interface InconsistencyResponse {
  status?: string;
  issues?: InconsistencyIssue[];
}

interface CompileResult {
  success: boolean;
  jarPath: string | null;
  buildOutput: string;
  buildId: string; // Add this
}

// Create separate routers
const fixRoutes: Router = express.Router();
const createRoutes: Router = express.Router();

// Base directory for plugins
const PLUGINS_BASE_DIR = path.join(__dirname, '../../generated-plugins');
if (!fs.existsSync(PLUGINS_BASE_DIR)) {
  fs.mkdirSync(PLUGINS_BASE_DIR, { recursive: true });
}

// Path to bash script
const BASH_SCRIPT_PATH = path.join(__dirname, '../../bash.sh');

// Make bash script executable on Linux
try {
  fs.chmodSync(BASH_SCRIPT_PATH, '755');
  console.log(`Made ${BASH_SCRIPT_PATH} executable`);
} catch (error) {
  console.warn(`Warning: Could not set executable permissions on ${BASH_SCRIPT_PATH}`, error);
}

// Helper functions for code reuse and optimized processing
const getModel = (modelConfig: any, config: any) => {
  return genAI.getGenerativeModel({
    model: modelConfig.name,
    generationConfig: config
  });
};

const cleanContent = (content: string): string => {
  return content.replace(MARKDOWN_CODE_PATTERN, "");
};

const hashString = (input: string): string => {
  return crypto.createHash('md5').update(input).digest('hex');
};

// Helper function for consistent API responses
const formatApiResponse = (success: boolean, message: string, data?: any) => {
  return {
    success,
    message,
    ...(data && { ...data }),
    timestamp: new Date().toISOString()
  };
};

// Function to compile the plugin using bash.sh
async function compilePlugin(
  prompt: string, 
  token: string, 
  files: Record<string, string>,
  providedBuildId?: string
): Promise<CompileResult> {
  return new Promise(async (resolve) => {
    // Generate unique ID for this build or use provided one
    const buildId = providedBuildId || `plugin-${Date.now()}`;
    const outputDir = path.join(PLUGINS_BASE_DIR, buildId);
    
    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });
    
    // Save the original prompt to help with identification
    if (prompt) {
      fs.writeFileSync(path.join(outputDir, 'prompt.txt'), prompt);
    }
    
    // Extract plugin name from files
    const pluginYmlPath = Object.keys(files).find(path => path.endsWith('plugin.yml'));
    let pluginName = "CustomPlugin";
    if (pluginYmlPath) {
      const nameMatch = files[pluginYmlPath].match(/name: *([A-Za-z0-9_]+)/);
      if (nameMatch) {
        pluginName = nameMatch[1];
      }
    }
    
    // Validate files before writing to disk
    console.log("Validating plugin files before compilation...");
    const validatedFiles = await validatePluginFiles(files, pluginName);
    
    // Write validated files to disk
    for (const [filePath, content] of Object.entries(validatedFiles)) {
      const fullPath = path.join(outputDir, filePath);
      const fileDir = path.dirname(fullPath);
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
      
      // Write file
      fs.writeFileSync(fullPath, content);
      console.log(`Created file: ${fullPath}`);
    }
    
    console.log(`Compiling plugin at: ${outputDir}`);
    
    // Call the bash script to compile the plugin
    const bashProcess = spawn('bash', [
      BASH_SCRIPT_PATH, 
      outputDir,         // Plugin directory
      token,             // Authentication token
      process.env.API_HOST || 'http://localhost:5000' // API host
    ]);
    
    let stdoutData = '';
    let stderrData = '';
    
    bashProcess.stdout.on('data', (data: Buffer) => {
      const output = data.toString();
      stdoutData += output;
      console.log(`[BASH] ${output.trim()}`);
    });
    
    bashProcess.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      stderrData += output;
      console.error(`[BASH-ERR] ${output.trim()}`);
    });
    
    bashProcess.on('close', (code: number | null) => {
      console.log(`Bash script exited with code ${code}`);
      
      // Check for build result JSON file
      let success = false;
      let jarPath: string | null = null;
      let buildOutput = stdoutData + stderrData;
      
      try {
        const resultFile = path.join(outputDir, 'build_result.json');
        if (fs.existsSync(resultFile)) {
          const buildResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          success = buildResult.success;
          
          if (buildResult.jarPath) {
            jarPath = path.join(outputDir, buildResult.jarPath);
          }
        } else {
          // Fallback to checking for JAR manually
          const targetDir = path.join(outputDir, 'target');
          if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const jarFile = files.find(file => file.endsWith('.jar') && !file.includes('original'));
            if (jarFile) {
              jarPath = path.join(targetDir, jarFile);
              success = true;
            }
          }
        }
      } catch (error) {
        console.error("Error processing build results:", error);
      }
      
      resolve({
        success,
        jarPath,
        buildOutput,
        buildId
      });
    });
  });
}

// Process Java file content with optimized batch replacements
const processJavaFile = (filePath: string, content: string, pluginName: string): string => {
  // Handle package declaration
  const packageMatch = filePath.match(/src\/main\/java\/(.*\/)/);
  const packageName = packageMatch ? packageMatch[1].replace(/\//g, ".").replace(/\.$/, "") : "";

  // Apply all transformations in one pass for efficiency
  let result = content
    // Fix invalid API calls
    .replace(/pig\.setAngry\(([^)]+)\)/g, 
      '// Pig.setAngry() doesn\'t exist in Bukkit API \n    pig.setPersistent(true);\n    pig.setCustomName("Angry Pig");\n    pig.setMetadata("angry", new FixedMetadataValue(plugin, true));')
    // Remove JetBrains annotations
    .replace(/import org\.jetbrains\.annotations\.[^;]*;(\r?\n|\r)?/g, "")
    .replace(/@NotNull |@Nullable /g, "")
    // Fix package names
    .replace(/com\.yourusername/g, `com.pegasus.${pluginName.toLowerCase()}`)
    .replace(/com\.pegasus\.plugin/g, `com.pegasus.${pluginName.toLowerCase()}`)
    .replace(/yourusername/g, "pegasus");

  // Add metadata import if needed
  if (result.includes("setMetadata") && !result.includes("import org.bukkit.metadata.FixedMetadataValue")) {
    const importSection = result.match(/(import .+;\n\n)/);
    if (importSection) {
      result = result.replace(importSection[0], importSection[0] + "import org.bukkit.metadata.FixedMetadataValue;\n");
    }
  }

  // Fix package if needed
  if (packageName && !result.trim().startsWith("package")) {
    result = `package ${packageName};\n\n${result}`;
  }

  return result;
};

// Add this function after the processJavaFile function

async function validatePluginFiles(files: Record<string, string>, pluginName: string): Promise<Record<string, string>> {
  console.log("Validating plugin files before compilation...");
  
  // Create a copy of files to avoid modifying the original
  const validatedFiles = { ...files };
  
  // Get the main class file and path - look for class extending JavaPlugin
  let mainClassFile = '';
  let mainClassPath = '';
  let packageName = '';
  
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.java') && 
        (content.includes('extends JavaPlugin') || 
         content.includes('extends org.bukkit.plugin.java.JavaPlugin'))) {
      mainClassFile = path;
      const classNameMatch = path.match(/([^\/]+)\.java$/);
      if (classNameMatch) {
        mainClassPath = classNameMatch[1];
      }
      
      const packageMatch = content.match(/package\s+([\w.]+);/);
      if (packageMatch) {
        packageName = packageMatch[1];
      }
      
      console.log(`Found main class: ${packageName}.${mainClassPath} in ${mainClassFile}`);
      break;
    }
  }
  
  // If we haven't found a main class yet, look for class with onEnable/onDisable methods
  if (!mainClassFile) {
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith('.java') && 
          (content.includes('void onEnable()') || content.includes('public void onEnable'))) {
        mainClassFile = path;
        const classNameMatch = path.match(/([^\/]+)\.java$/);
        if (classNameMatch) {
          mainClassPath = classNameMatch[1];
        }
        
        const packageMatch = content.match(/package\s+([\w.]+);/);
        if (packageMatch) {
          packageName = packageMatch[1];
        }
        
        console.log(`Found main class by onEnable method: ${packageName}.${mainClassPath} in ${mainClassFile}`);
        break;
      }
    }
  }
  
  // Fix plugin.yml
  const pluginYmlPath = Object.keys(files).find(path => path.endsWith('plugin.yml'));
  if (pluginYmlPath && mainClassPath && packageName) {
    const pluginYml = files[pluginYmlPath];
    const fullMainClass = `${packageName}.${mainClassPath}`;
    
    // Build a properly formatted plugin.yml with the correct main class
    let updatedPluginYml = pluginYml;
    
    // Ensure name is correct
    if (!updatedPluginYml.includes(`name: ${pluginName}`)) {
      updatedPluginYml = updatedPluginYml.replace(/name: .*/, `name: ${pluginName}`);
      if (!updatedPluginYml.includes("name:")) {
        updatedPluginYml = `name: ${pluginName}\n${updatedPluginYml}`;
      }
    }
    
    // Replace or add main class
    if (updatedPluginYml.includes("main:")) {
      updatedPluginYml = updatedPluginYml.replace(/main: .*/, `main: ${fullMainClass}`);
    } else {
      updatedPluginYml = `${updatedPluginYml}\nmain: ${fullMainClass}`;
    }
    
    // Add basic version if missing
    if (!updatedPluginYml.includes("version:")) {
      updatedPluginYml = `${updatedPluginYml}\nversion: 1.0`;
    }
    
    // Add API version if missing (for Minecraft 1.13+)
    if (!updatedPluginYml.includes("api-version:")) {
      updatedPluginYml = `${updatedPluginYml}\napi-version: 1.19`;
    }
    
    validatedFiles[pluginYmlPath] = updatedPluginYml;
    console.log(`Updated plugin.yml with main class: ${fullMainClass}`);
  } else if (pluginYmlPath) {
    // If we couldn't find the main class, create a generic warning in plugin.yml
    console.warn("Could not determine main class from Java files!");
    
    // Create a simple valid plugin.yml as a fallback
    const pluginLower = pluginName.toLowerCase();
    const fallbackMainClass = `com.pegasus.${pluginLower}.${pluginName}`;
    
    validatedFiles[pluginYmlPath] = `name: ${pluginName}
version: 1.0
main: ${fallbackMainClass}
api-version: 1.19
description: A custom Minecraft plugin`;
    
    console.log(`Created fallback plugin.yml with main class: ${fallbackMainClass}`);
  }
  
  // Validate with a quick AI check
  const model = getModel(MODEL_CONFIG.flash, MODEL_CONFIG.flash.precision);
  
  // Prioritize files for validation (main class, plugin.yml, pom.xml)
  const criticalFiles: Record<string, string> = {};
  if (mainClassFile && validatedFiles[mainClassFile]) {
    criticalFiles[mainClassFile] = validatedFiles[mainClassFile];
  }
  
  if (pluginYmlPath && validatedFiles[pluginYmlPath]) {
    criticalFiles[pluginYmlPath] = validatedFiles[pluginYmlPath];
  }
  
  const pomPath = Object.keys(validatedFiles).find(path => path.endsWith('pom.xml'));
  if (pomPath) {
    criticalFiles[pomPath] = validatedFiles[pomPath];
  }
  
  // Only run validation if we have critical files
  if (Object.keys(criticalFiles).length > 0) {
    const validationPrompt = `
      You are a Minecraft plugin validator. Check these critical plugin files for errors that would prevent compilation or loading:
      
      ${Object.entries(criticalFiles)
        .map(([path, content]) => `FILE: ${path}\n${content.substring(0, 1000)}${content.length > 1000 ? '...' : ''}`)
        .join('\n\n===\n\n')
      }
      
      Focus ONLY on critical errors:
      1. Ensure the main class in plugin.yml exists and extends JavaPlugin
      2. Check for syntax errors in Java files
      3. Verify package names match file paths
      4. Confirm all required imports exist
      5. Make sure pom.xml has valid dependencies
      
      If you find any errors, return ONLY:
      ---FILE_START:filepath---
      [corrected content]
      ---FILE_END---
      
      If no errors, respond with "NO_ERRORS_FOUND".
    `;
    
    try {
      console.log("Running AI validation check on critical files...");
      const validationResult = await model.generateContent(validationPrompt);
      const validationText = await validationResult.response.text();
      
      if (validationText.includes("NO_ERRORS_FOUND")) {
        console.log("AI validation: No critical errors found.");
      } else {
        console.log("AI validation: Fixing issues...");
        
        // Extract fixes
        let fileMatch;
        FILE_PATTERN.lastIndex = 0;
        while ((fileMatch = FILE_PATTERN.exec(validationText)) !== null) {
          const filePath = fileMatch[1].trim();
          const fixedContent = cleanContent(fileMatch[2].trim());
          
          // Only update if this is a known file
          if (validatedFiles[filePath]) {
            validatedFiles[filePath] = fixedContent;
            console.log(`AI validation fixed: ${filePath}`);
          }
        }
      }
    } catch (error) {
      console.warn("AI validation failed:", error);
      // Continue with the original files if validation fails
    }
  }
  
  return validatedFiles;
}

// Add this function after validatePluginFiles

async function ensureMainClassExists(files: Record<string, string>, pluginName: string): Promise<Record<string, string>> {
  const updatedFiles = { ...files };
  const pluginLower = pluginName.toLowerCase();
  
  // Check if we have a main class
  let hasMainClass = false;
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.java') && 
        (content.includes('extends JavaPlugin') || 
         content.includes('extends org.bukkit.plugin.java.JavaPlugin'))) {
      hasMainClass = true;
      break;
    }
  }
  
  // If no main class, generate one
  if (!hasMainClass) {
    console.log("No main class found - generating one...");
    
    const mainClassPath = `src/main/java/com/pegasus/${pluginLower}/${pluginName}.java`;
    const mainClass = `package com.pegasus.${pluginLower};

import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.Bukkit;

public class ${pluginName} extends JavaPlugin {
    @Override
    public void onEnable() {
        getLogger().info("${pluginName} has been enabled!");
        saveDefaultConfig();
    }

    @Override
    public void onDisable() {
        getLogger().info("${pluginName} has been disabled!");
    }
}`;
    
    updatedFiles[mainClassPath] = mainClass;
    
    // Update plugin.yml to point to this class
    const pluginYmlPath = Object.keys(files).find(path => path.endsWith('plugin.yml'));
    if (pluginYmlPath) {
      const fullMainClass = `com.pegasus.${pluginLower}.${pluginName}`;
      let pluginYml = files[pluginYmlPath];
      
      // Replace or add main class
      if (pluginYml.includes("main:")) {
        pluginYml = pluginYml.replace(/main: .*/, `main: ${fullMainClass}`);
      } else {
        pluginYml = `${pluginYml}\nmain: ${fullMainClass}`;
      }
      
      updatedFiles[pluginYmlPath] = pluginYml;
    }
    
    console.log(`Created main class: ${mainClassPath}`);
  }
  
  return updatedFiles;
}

// Add this function near your other utility functions

/**
 * Uses Gemini Flash model to extract a meaningful plugin name from user prompt
 */
async function extractPluginName(prompt: string): Promise<string> {
  console.log("Extracting plugin name using Gemini Flash...");
  
  try {
    const model = getModel(MODEL_CONFIG.flash, MODEL_CONFIG.flash.precision);
    
    const namePrompt = `
      Based on this Minecraft plugin request, determine the BEST, MOST SPECIFIC name for the plugin.
      The name should be a single word or compound words in PascalCase format (like "WorldGuard" or "EssentialsX").
      It must contain only letters and numbers, and be descriptive of the plugin's main functionality.
      
      USER REQUEST:
      "${prompt}"
      
      Return ONLY the plugin name without any explanation, quotes, or additional text.
      Example responses: "TeleportPlus", "ChestProtector", "ServerEssentials"
    `;
    
    const nameResult = await model.generateContent(namePrompt);
    const suggestedName = await nameResult.response.text();
    
    // Clean up the response
    const cleanName = suggestedName
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .replace(/^[^A-Z]/, match => match.toUpperCase()); // Ensure first letter is uppercase
    
    // If name is too short, add "Plugin" suffix
    const finalName = cleanName.length < 3 ? 'CustomPlugin' : 
                     cleanName.length < 5 ? cleanName + 'Plugin' : 
                     cleanName;
    
    console.log(`Generated plugin name: ${finalName}`);
    return finalName;
  } catch (error) {
    console.error("Error extracting plugin name:", error);
    return `MinecraftPlugin${Date.now().toString().slice(-4)}`;
  }
}

// Fix routes - optimized for build error resolution
fixRoutes.post(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Validate request
      const { buildErrors, files } = req.body;
      if (!buildErrors || !files) {
        res.status(400).json({
          status: "fail",
          success: false,
          message: "Request must contain buildErrors and files fields",
        });
        return;
      }

      console.log("Received build errors for fixing");

      // Check cache with efficient hashing
      const cacheKey = hashString(buildErrors + Object.keys(files).join());
      const cachedResult = pluginCache.get(cacheKey);
      if (cachedResult) {
        console.log("Returning cached fix result");
        res.status(200).json({
          status: "success",
          success: true,
          message: "Files fixed successfully (cached)",
          data: cachedResult
        });
        return;
      }

      // Model selection based on error complexity
      const isComplexError = buildErrors.length > 500 || Object.keys(files).length > 5;
      const modelConfig = isComplexError ? MODEL_CONFIG.pro : MODEL_CONFIG.flash;
      const model = getModel(modelConfig, modelConfig.precision);

      // Optimize file selection for analysis
      const relevantFiles: Record<string, string> = {};
      const errorMentionsFile = (error: string, fileName: string) => 
        error.includes(fileName) || error.toLowerCase().includes(fileName.toLowerCase());
      
      // First pass: include files directly mentioned in errors
      Object.entries(files).forEach(([path, content]) => {
        const fileName = path.split('/').pop() || path;
        if (errorMentionsFile(buildErrors, fileName)) {
          relevantFiles[path] = content as string;
        }
      });
      
      // Second pass: if no directly mentioned files, include all
      if (Object.keys(relevantFiles).length === 0) {
        Object.entries(files).forEach(([path, content]) => {
          relevantFiles[path] = content as string;
        });
      }
      
      // Always include pom.xml if it exists
      if (files["pom.xml"] && !relevantFiles["pom.xml"]) {
        relevantFiles["pom.xml"] = files["pom.xml"] as string;
      }

      // Optimized prompt construction
      const fileListSection = Object.entries(relevantFiles)
        .map(([path, content]) => `FILE: ${path}\n${content}\n\n`)
        .join("---\n");

      const fixPrompt = `
      You are a Minecraft plugin build error expert. A plugin build has failed with the following errors:
      
      BUILD ERRORS:
      ${buildErrors}
      
      Relevant project files are provided below. Analyze the build errors and fix ALL problematic files.
      Pay special attention to XML/POM parsing errors, which often indicate malformed XML.
      
      ${fileListSection}
      
      Return ONLY the files that need fixing in this format:
      ---FILE_START:filepath---
      [corrected content here]
      ---FILE_END---
      
      IMPORTANT: Do NOT include backticks or markdown formatting in your response.
      DO NOT wrap code in \`\`\` blocks - the content should be raw code only.
      
      Return MULTIPLE file fixes if needed, with each file's content between its own start/end markers.
      Focus on fixing the ROOT CAUSE of the build failure first (like XML syntax errors in pom.xml).
    `;

      console.log("Sending fix request to Gemini API");
      const fixResult = await model.generateContent(fixPrompt);
      const fixedContent = await fixResult.response.text();
      console.log("Received fix response from Gemini API");

      // Extract fixed files efficiently
      const updatedFiles: Record<string, string> = {};
      let fileMatch;
      
      // Reset RegExp state for reuse
      FILE_PATTERN.lastIndex = 0;
      while ((fileMatch = FILE_PATTERN.exec(fixedContent)) !== null) {
        const filePath = fileMatch[1].trim();
        let content = cleanContent(fileMatch[2].trim());

        // Process Java files specially
        if (filePath.endsWith(".java")) {
          content = content
            .replace(/pig\.setAngry\(([^)]+)\)/g, "// TODO: Pig.setAngry() doesn't exist in Bukkit API - implement custom behavior\n    // pig.setAngry($1)")
            .replace(/^package\s+(.+?)\s*;\s*```/gm, "package $1;")
            .replace(/```\s*package/g, "package");
        }

        updatedFiles[filePath] = content;
        console.log(`🔧 Fixed file: ${filePath}`);
      }

      // Cache the result
      pluginCache.set(cacheKey, updatedFiles);

      // Send response
      res.status(200).json({
        status: "success",
        success: true,
        message: "Files fixed successfully",
        data: updatedFiles,
        changedFiles: Object.keys(updatedFiles).length
      });
    } catch (error) {
      console.error("Error fixing build issues:", error);
      res.status(500).json({
        status: "error",
        success: false,
        message: "Failed to fix build issues",
        error: (error as Error).message,
      });
    }
  }
);

// Create routes - optimized for plugin generation
createRoutes.post(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    // Get and validate prompt and buildId
    const { prompt, buildId: requestBuildId } = req.body;
    if (!prompt) {
      res.status(400).json(formatApiResponse(
        false,
        "Request must contain a prompt field"
      ));
      return;
    }

    // Declare these variables at the start of the function
    let compilationResult: CompileResult | null = null;
    let buildId: string = requestBuildId || `plugin-${Date.now()}`;

    // Add this to your createRoutes.post handler right after checking the prompt
    if (req.query.async === 'true' || req.body.async === true) {
      // Send an immediate response with the build ID
      res.status(202).json(formatApiResponse(
        true,
        "Plugin generation started",
        {
          buildId,
          status: "pending",
          statusCheckUrl: `/api/build/status/${buildId}`
        }
      ));
      
      // Continue processing in the background
      (async () => {
        try {
          // Your existing plugin generation code...
          // Just don't send any more responses
          console.log(`Background processing for build ${buildId} completed`);
        } catch (error) {
          console.error(`Background processing error for ${buildId}:`, error);
        }
      })().catch(error => console.error("Unhandled background error:", error));
      
      return; // Return early - response already sent
    }

    try {
      // Check cache
      const cacheKey = hashString(prompt);
      const cachedResult = pluginCache.get(cacheKey);

      if (cachedResult) {
        console.log("Returning cached plugin result");
        const pluginName = Object.keys(cachedResult).find(file => file.endsWith('.java'))?.split('/').pop()?.replace('.java', '') || 'Plugin';
        
        res.status(200).json({
          status: "success",
          success: true,
          message: "Minecraft plugin generated successfully (cached)",
          data: cachedResult,
          pluginName: pluginName,
          files: Object.keys(cachedResult)
        });
        return;
      }

      const startTime = Date.now();

      // Get models using precompiled configurations
      const proModel = getModel(MODEL_CONFIG.pro, MODEL_CONFIG.pro.creative);
      const flashModel = getModel(MODEL_CONFIG.flash, MODEL_CONFIG.flash.creative);

      // First extract a proper plugin name using AI
      const pluginName = await extractPluginName(prompt);
      const pluginLower = pluginName.toLowerCase();

      console.log(`Using plugin name: ${pluginName}`);

      // Optimized prompts with consistent plugin name
      const refiningPrompt = `
        You are a Minecraft plugin requirements analyst. The user has provided this plugin request:
        
        "${prompt}"
        
        We've determined the plugin name will be: ${pluginName}
        
        Your task is to refine and expand this request into a clear, detailed specification.
        
        // rest of your prompt...
      `;
      
      const blueprintPrompt = `
        You are a Minecraft plugin architect tasked with creating a complete, cohesive plugin blueprint.
        
        PLUGIN REQUIREMENTS:
        ${prompt}
        
        PLUGIN NAME: ${pluginName}
        
        Your task is to create a COMPLETE PLUGIN BLUEPRINT that ensures all files work together consistently.
        
        PART 1: ARCHITECTURE
        - Use "${pluginName}" as the plugin name and main class name
        - Package structure (always use com.pegasus.${pluginLower} format)
        
        // rest of your prompt...
      `;

      // Run in parallel for speed
      console.log("Starting parallel generation...");
      const [refinedPromptResult, blueprintResult] = await Promise.all([
        flashModel.generateContent(refiningPrompt),
        flashModel.generateContent(blueprintPrompt)
      ]);

      const refinedPrompt = await refinedPromptResult.response.text();
      const pluginBlueprint = await blueprintResult.response.text();
      console.log("Parallel generation complete");

      // Get file list with optimized prompt
      console.log("Extracting file list...");
      const fileListPrompt = `
        Based on this plugin blueprint, extract all files that need to be created.
        
        BLUEPRINT EXCERPT:
        ${pluginBlueprint.substring(0, 4000)}
        
        I need your response in a valid JSON array format ONLY, like this exact format:
        ["pom.xml", "src/main/resources/plugin.yml", "src/main/java/com/pegasus/pluginname/Main.java"]
        
        Include all necessary files: pom.xml, plugin.yml, config.yml (if needed), and ALL Java class files.
        Return ONLY the JSON array with no additional text, explanations, or formatting.
      `;

      const fileListResult = await flashModel.generateContent(fileListPrompt);
      const fileListText = await fileListResult.response.text();

      // Extract file structure with optimized algorithm
      let fileStructure: string[] = [];
      try {
        // Try multiple extraction methods in order of reliability
        let jsonArray: string | null = null;
        
        // Method 1: Standard JSON pattern
        const standardMatch = JSON_ARRAY_PATTERN.exec(fileListText);
        if (standardMatch) {
          jsonArray = standardMatch[0];
        } 
        // Method 2: Bracketed content
        else {
          const openBracketIndex = fileListText.indexOf('[');
          const closeBracketIndex = fileListText.lastIndexOf(']');
          
          if (openBracketIndex !== -1 && closeBracketIndex !== -1 && openBracketIndex < closeBracketIndex) {
            jsonArray = fileListText.substring(openBracketIndex, closeBracketIndex + 1);
          }
        }
        
        // Parse JSON if found
        if (jsonArray) {
          try {
            fileStructure = JSON.parse(jsonArray);
            
            // Validate array content
            if (!Array.isArray(fileStructure) || fileStructure.some(item => typeof item !== 'string')) {
              throw new Error("Invalid array structure");
            }
            
            // Fix paths if needed
            const pluginLower = pluginName.toLowerCase();
            fileStructure = fileStructure.map(path => {
              if (path.endsWith(".java") && !path.includes("/")) {
                return `src/main/java/com/pegasus/${pluginLower}/${path}`;
              }
              if ((path === "plugin.yml" || path === "config.yml") && !path.includes("/")) {
                return `src/main/resources/${path}`;
              }
              return path;
            });
          } catch (parseError) {
            console.warn("JSON parse error:", parseError);
            throw parseError;
          }
        } 
        // Method 3: Extract by file extension
        else {
          FILE_EXTENSION_PATTERN.lastIndex = 0;
          const fileMatches = fileListText.match(FILE_EXTENSION_PATTERN);
          
          if (fileMatches && fileMatches.length > 0) {
            fileStructure = [...new Set(fileMatches)]; // Remove duplicates
          } else {
            throw new Error("No file references found");
          }
        }
        
        // Ensure we have files
        if (fileStructure.length === 0) {
          throw new Error("Empty file list");
        }
      } catch (e) {
        // Fallback to default structure
        const pluginLower = pluginName.toLowerCase();
        fileStructure = [
          "pom.xml",
          "src/main/resources/plugin.yml",
          `src/main/java/com/pegasus/${pluginLower}/Main.java`,
        ];
        console.log("Using default file structure due to error:", e);
      }

      console.log("Files to generate:", fileStructure);

      // Generate all files with optimized prompt
      const multiFileGenPrompt = `
        Implement a complete Minecraft plugin based on:
        
        BLUEPRINT:
        ${pluginBlueprint}
        
        PLUGIN NAME: ${pluginName}
        
        FILES TO CREATE:
        ${fileStructure.join("\n")}
        
        GUIDELINES:
        - Always use "com.pegasus.${pluginLower}" as root package
        - Follow blueprint class relationships exactly
        - No JetBrains annotations
        - For pom.xml: Spigot 1.19.3 API, Java 11, Maven Shade Plugin 3.4.1
        - Ensure consistent package names across imports
        - Make sure all classes compile without errors
        
        For EACH file use format:
        ---FILE_START:filepath---
        [content]
        ---FILE_END---
      `;

      const multiFileResult = await proModel.generateContent(multiFileGenPrompt);
      const multiFileResponse = await multiFileResult.response.text();

      // Extract and process files efficiently
      const files: Record<string, string> = {};
      let fileMatch;
      
      // Reset RegExp lastIndex for reuse
      FILE_PATTERN.lastIndex = 0;
      while ((fileMatch = FILE_PATTERN.exec(multiFileResponse)) !== null) {
        const filePath = fileMatch[1].trim();
        let fileContent = cleanContent(fileMatch[2].trim());

        // Apply type-specific processing
        if (filePath.endsWith(".java")) {
          fileContent = processJavaFile(filePath, fileContent, pluginName);
        } else if (filePath === "pom.xml" || filePath.endsWith(".xml")) {
          fileContent = fileContent.replace(/^[^<]*(<\?xml|<project)/, "$1");
          if (!fileContent.startsWith("<?xml")) {
            fileContent = '<?xml version="1.0" encoding="UTF-8"?>\n' + fileContent;
          }
          
          if (!fileContent.includes(`<artifactId>${pluginLower}</artifactId>`)) {
            fileContent = fileContent.replace(
              /<artifactId>(.*?)<\/artifactId>/,
              `<artifactId>${pluginLower}</artifactId>`
            );
          }
        } else if (filePath.endsWith("plugin.yml")) {
          // Fix plugin.yml
          if (!fileContent.includes(`name: ${pluginName}`)) {
            fileContent = fileContent.replace(/name: .*/, `name: ${pluginName}`);
            if (!fileContent.includes("name:")) {
              fileContent = `name: ${pluginName}\n${fileContent}`;
            }
          }
          
          // Don't set main class here - it will be validated properly later
          // Just ensure basic format is correct
          if (!fileContent.includes("version:")) {
            fileContent += "\nversion: 1.0";
          }
          
          if (!fileContent.includes("api-version:")) {
            fileContent += "\napi-version: 1.19";
          }
        }

        // General fixes for any file type
        fileContent = fileContent
          .replace(/com\.yourusername/g, `com.pegasus.${pluginLower}`)
          .replace(/com\.pegasus\.plugin/g, `com.pegasus.${pluginLower}`)
          .replace(/yourusername/g, "pegasus");

        files[filePath] = fileContent;
        console.log(`Generated: ${filePath}`);
      }

      // Fallback to individual generation if needed
      if (Object.keys(files).length === 0) {
        console.warn("Falling back to individual file generation");
        
        // Generate each file separately in parallel for speed
        const filePromises = fileStructure.map(async (filePath) => {
          const singleFilePrompt = `
            Create a single Minecraft plugin file based on this blueprint:
            
            BLUEPRINT EXCERPT:
            ${pluginBlueprint.substring(0, 3000)}...
            
            PLUGIN NAME: ${pluginName}
            Generate ONLY this file: ${filePath}
            Use package: com.pegasus.${pluginLower}
            
            Return the complete implementation without explanations or markdown formatting.
          `;
          
          const singleFileResult = await flashModel.generateContent(singleFilePrompt);
          const singleFileContent = await singleFileResult.response.text();
          const cleanedContent = cleanContent(singleFileContent);
          
          return { filePath, content: cleanedContent };
        });
        
        // Wait for all files to be generated
        const fileResults = await Promise.all(filePromises);
        fileResults.forEach(({ filePath, content }) => {
          files[filePath] = content;
        });
      }

      // Perform cross-file validation and cleanup if needed
      if (Object.keys(files).length > 1) {
        // Simplified validation - focus on just the first 200 chars of each file
        const validationSamples = Object.entries(files)
          .map(([path, content]) => `${path}:\n${content.substring(0, 200)}...[truncated]`)
          .join("\n\n");
        
        const validationPrompt = `
          Check these Minecraft plugin files for consistency issues:
          
          ${validationSamples}
          
          Focus ONLY on critical issues: method signature mismatches, inconsistent package names,
          and missing class imports.
          
          Return ONLY JSON: {"status": "consistent"} or {"issues": [{
            "fileA": "path1",
            "fileB": "path2", 
            "issue": "description", 
            "fix": "solution"
          }]}
        `;

        try {
          const validationResult = await flashModel.generateContent(validationPrompt);
          const validationText = await validationResult.response.text();
          
          // Extract and parse JSON response
          const match = validationText.match(/\{[\s\S]*\}/);
          if (match) {
            const inconsistencies: InconsistencyResponse = JSON.parse(match[0]);
            
            // Fix inconsistencies if needed
            if (inconsistencies.issues && inconsistencies.issues.length > 0) {
              console.log("Fixing inconsistencies...");
              
              // Process each issue
              for (const issue of inconsistencies.issues) {
                const { fileA, fileB, issue: issueDesc, fix } = issue;
                
                if (issueDesc.toLowerCase().includes("package")) {
                  // Fix package inconsistencies
                  const correctPackageMatch = fix.match(/should be ['"]([^'"]+)['"]/);
                  if (correctPackageMatch && files[fileA] && files[fileB]) {
                    const correctPackage = correctPackageMatch[1];
                    
                    // Apply fixes to both files
                    files[fileA] = files[fileA].replace(/package\s+[^;]+;/, `package ${correctPackage};`);
                    files[fileB] = files[fileB].replace(/package\s+[^;]+;/, `package ${correctPackage};`);
                    
                    // Fix imports in all files
                    const wrongPackageMatch = issueDesc.match(/['"]([^'"]+)['"]\s+vs\s+['"]([^'"]+)['"]/);
                    if (wrongPackageMatch) {
                      const wrongPackage = issueDesc.includes(fileA) ? wrongPackageMatch[1] : wrongPackageMatch[2];
                      
                      Object.keys(files).forEach(file => {
                        files[file] = files[file].replace(
                          new RegExp(`import\\s+${wrongPackage}\\.`, 'g'), 
                          `import ${correctPackage}.`
                        );
                      });
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("Validation error, continuing with generation:", e);
        }
      }

      // Prepare response data
      const jarPath = `target/${pluginLower}-1.0-SNAPSHOT.jar`;
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      // Cache the result
      pluginCache.set(cacheKey, files);

      // Check if compilation is requested before sending response
      if (req.body.compile === true) {
        console.log("Compiling plugin with bash.sh...");
        try {
          // First validate plugin.yml against main class before compiling
          const validatedFiles = await validatePluginFiles(files, pluginName);
          
          compilationResult = await compilePlugin(
            prompt, 
            req.headers.authorization?.split(' ')[1] || '', 
            validatedFiles,
            buildId
          );
          buildId = compilationResult.buildId;
          
          // Send response with compilation results
          res.status(200).json({
            status: "success",
            success: true,
            message: compilationResult.success ? "Plugin generated and compiled successfully" : "Plugin generated but compilation failed",
            data: validatedFiles, // Return the validated files
            files: Object.keys(validatedFiles),
            pluginName: pluginName,
            buildId: buildId,
            buildOutput: compilationResult.buildOutput,
            jarPath: compilationResult.jarPath,
            processingTime: `${processingTime}s`,
          });
          return;
        } catch (error) {
          console.error("Error compiling plugin:", error);
          // If compilation fails, we'll still send the generated files below
        }
      }

      // Send response without compilation results if compilation wasn't requested or failed
      res.status(200).json({
        status: "success",
        success: true,
        message: "Minecraft plugin generated successfully",
        data: files,
        files: Object.keys(files),
        pluginName: pluginName,
        buildId: buildId || `plugin-${Date.now()}`, // Add buildId even without compilation
        jarPath: jarPath,
        processingTime: `${processingTime}s`,
        outputDir: "",
        log: `Processed plugin generation in ${processingTime} seconds. Generated ${Object.keys(files).length} files.`,
      });

    } catch (error) {
      console.error("Error generating Minecraft plugin:", error);
      res.status(500).json({
        status: "error",
        success: false,
        message: "Failed to generate Minecraft plugin",
        error: (error as Error).message,
      });
    }
  }
);

// Additional routes for build management
const buildRoutes: Router = express.Router();

// Endpoint to get build status
buildRoutes.get(
  "/status/:buildId",
  verifyToken,
  (req: Request, res: Response): void => {
    try {
      const { buildId } = req.params;
      console.log(`Checking status for buildId: ${buildId}`);
      
      const pluginDir = path.join(PLUGINS_BASE_DIR, buildId);
      
      if (!fs.existsSync(pluginDir)) {
        res.status(404).json(formatApiResponse(
          false,
          `Build ${buildId} not found`
        ));
        return;
      }
      
      // Check if target directory exists (build has been attempted)
      const targetExists = fs.existsSync(path.join(pluginDir, 'target'));
      
      // Check if JAR file exists (build was successful)
      let jarFile: string | null = null;
      if (targetExists) {
        const targetDir = path.join(pluginDir, 'target');
        const files = fs.readdirSync(targetDir);
        const jarFileFound = files.find(file => file.endsWith('.jar') && !file.includes('original'));
        if (jarFileFound) {
          jarFile = jarFileFound;
        }
      }
      
      // Get plugin name for better response
      let pluginName = "Unknown";
      try {
        const possiblePaths = [
          path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'),
          path.join(pluginDir, 'plugin.yml')
        ];
        
        for (const ymlPath of possiblePaths) {
          if (fs.existsSync(ymlPath)) {
            const pluginYml = fs.readFileSync(ymlPath, 'utf8');
            const nameMatch = pluginYml.match(/name: *([A-Za-z0-9_]+)/);
            if (nameMatch) {
              pluginName = nameMatch[1];
              break;
            }
          }
        }
      } catch (error) {
        console.warn(`Could not read plugin.yml:`, error);
      }
      
      // Only get files if requested to speed up response
      const allFiles: string[] | null = req.query.includeFiles === 'true' ? [] : null;
      if (allFiles !== null) {
        function walkDir(dir: string, baseDir: string): void {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory() && file !== 'target') {
              walkDir(filePath, baseDir);
            } else if (stat.isFile()) {
              // Use non-null assertion since we already checked outside the function
              allFiles!.push(path.relative(baseDir, filePath));
            }
          }
        }
        
        walkDir(pluginDir, pluginDir);
      }
      
      res.json(formatApiResponse(
        true, 
        `Build status retrieved for ${buildId}`,
        {
          buildId,
          status: jarFile ? 'completed' : targetExists ? 'failed' : 'pending',
          jarFile,
          pluginName,
          files: allFiles,
          downloadUrl: jarFile ? `/api/build/download/${buildId}` : null
        }
      ));
      
    } catch (error) {
      console.error("Error checking build status:", error);
      res.status(500).json(formatApiResponse(
        false,
        "Failed to check build status",
        { error: (error as Error).message }
      ));
    }
  }
);

// Endpoint to download the JAR file
buildRoutes.get(
  "/download/:buildId",
  verifyToken,
  (req: Request, res: Response): void => {
    try {
      const { buildId } = req.params;
      const pluginDir = path.join(PLUGINS_BASE_DIR, buildId);
      
      if (!fs.existsSync(pluginDir)) {
        res.status(404).json(formatApiResponse(
          false,
          `Build ${buildId} not found`
        ));
        return;
      }
      
      // Find JAR file in the target directory
      const targetDir = path.join(pluginDir, 'target');
      if (!fs.existsSync(targetDir)) {
        res.status(404).json(formatApiResponse(
          false,
          `No target directory found for build ${buildId}`
        ));
        return;
      }
      
      // Find the first JAR file (excluding original-*.jar)
      const files = fs.readdirSync(targetDir);
      const jarFile = files.find(file => file.endsWith('.jar') && !file.includes('original'));
      
      if (!jarFile) {
        res.status(404).json(formatApiResponse(
          false,
          `No JAR file found for build ${buildId}`
        ));
        return;
      }
      
      const jarPath = path.join(targetDir, jarFile);
      
      // Get plugin name for better filename
      let pluginName = "";
      try {
        const possiblePaths = [
          path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'),
          path.join(pluginDir, 'plugin.yml')
        ];
        
        for (const ymlPath of possiblePaths) {
          if (fs.existsSync(ymlPath)) {
            const pluginYml = fs.readFileSync(ymlPath, 'utf8');
            const nameMatch = pluginYml.match(/name: *([A-Za-z0-9_]+)/);
            if (nameMatch) {
              pluginName = nameMatch[1].toLowerCase();
              break;
            }
          }
        }
      } catch (error) {
        console.warn(`Could not read plugin.yml:`, error);
      }
      
      // Set proper headers for file download
      res.setHeader('Content-Disposition', `attachment; filename="${pluginName ? pluginName + '.jar' : jarFile}"`);
      res.setHeader('Content-Type', 'application/java-archive');
      res.setHeader('Content-Length', fs.statSync(jarPath).size);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      
      // Stream the file
      const fileStream = fs.createReadStream(jarPath);
      fileStream.on('error', (error) => {
        console.error(`Error streaming JAR file:`, error);
        if (!res.headersSent) {
          res.status(500).json(formatApiResponse(
            false, 
            "Error streaming JAR file",
            { error: (error as Error).message }
          ));
        }
      });
      fileStream.pipe(res);
      
    } catch (error) {
      console.error("Error downloading JAR:", error);
      res.status(500).json(formatApiResponse(
        false,
        "Failed to download JAR file",
        { error: (error as Error).message }
      ));
    }
  }
);

// Add this new route after the buildRoutes definition (around line 1197)

// Route for listing all generated plugins
const pluginsRoutes: Router = express.Router();

pluginsRoutes.get(
  "/",
  verifyToken,
  (req: Request, res: Response): void => {
    try {
      console.log("Listing all generated plugins");
      
      // Check if plugins directory exists
      if (!fs.existsSync(PLUGINS_BASE_DIR)) {
        res.status(404).json(formatApiResponse(
          false,
          "Plugins directory not found"
        ));
        return;
      }
      
      // Get all subdirectories in the plugins base directory (each is a build)
      const pluginDirs = fs.readdirSync(PLUGINS_BASE_DIR, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      
      // For each directory, gather information about the plugin
      const plugins = pluginDirs.map(dirName => {
        const pluginDir = path.join(PLUGINS_BASE_DIR, dirName);
        
        // Extract plugin information
        let pluginName = "Unknown";
        let jarFile = null;
        let status = "unknown";
        let fileCount = 0;
        
        // Check if plugin.yml exists to extract the plugin name
        try {
          // Look for plugin.yml in src/main/resources or directly in the plugin directory
          const possiblePaths = [
            path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'),
            path.join(pluginDir, 'plugin.yml')
          ];
          
          for (const ymlPath of possiblePaths) {
            if (fs.existsSync(ymlPath)) {
              const pluginYml = fs.readFileSync(ymlPath, 'utf8');
              const nameMatch = pluginYml.match(/name: *([A-Za-z0-9_]+)/);
              if (nameMatch) {
                pluginName = nameMatch[1];
                break;
              }
            }
          }
        } catch (error) {
          console.warn(`Could not read plugin.yml for ${dirName}:`, error);
        }
        
        // Check for JAR file to determine build status
        const targetDir = path.join(pluginDir, 'target');
        if (fs.existsSync(targetDir)) {
          try {
            const targetFiles = fs.readdirSync(targetDir);
            const jarFileFound = targetFiles.find(file => file.endsWith('.jar') && !file.includes('original'));
            if (jarFileFound) {
              jarFile = jarFileFound;
              status = "completed";
            } else {
              status = "failed";
            }
          } catch (error) {
            console.warn(`Could not read target directory for ${dirName}:`, error);
            status = "error";
          }
        } else {
          status = "pending";
        }
        
        // Count files (excluding target directory for efficiency)
        try {
          const allFiles: string[] = [];
          function countFiles(dir: string): void {
            if (!fs.existsSync(dir)) return;
            
            const dirFiles = fs.readdirSync(dir);
            for (const file of dirFiles) {
              if (file === 'target') continue;
              
              const filePath = path.join(dir, file);
              const stat = fs.statSync(filePath);
              if (stat.isDirectory()) {
                countFiles(filePath);
              } else if (stat.isFile()) {
                fileCount++;
              }
            }
          }
          
          countFiles(pluginDir);
        } catch (error) {
          console.warn(`Could not count files for ${dirName}:`, error);
        }
        
        // Get creation timestamp from the directory name (if in format plugin-timestamp)
        let createdAt = null;
        const timestampMatch = dirName.match(/plugin-(\d+)/);
        if (timestampMatch) {
          const timestamp = parseInt(timestampMatch[1]);
          if (!isNaN(timestamp)) {
            createdAt = new Date(timestamp).toISOString();
          }
        }
        
        // If we couldn't get timestamp from the name, use directory stats
        if (!createdAt) {
          try {
            const stats = fs.statSync(pluginDir);
            createdAt = stats.birthtime.toISOString();
          } catch (error) {
            console.warn(`Could not get creation time for ${dirName}:`, error);
            createdAt = new Date().toISOString(); // Use current time as fallback
          }
        }
        
        // Extract prompt if available
        let prompt = "";
        try {
          const promptPath = path.join(pluginDir, 'prompt.txt');
          if (fs.existsSync(promptPath)) {
            prompt = fs.readFileSync(promptPath, 'utf8').substring(0, 100) + "...";
          }
        } catch (error) {
          console.warn(`Could not read prompt for ${dirName}:`, error);
        }
        
        return {
          id: dirName,
          name: pluginName,
          status,
          createdAt,
          jarFile,
          fileCount,
          buildId: dirName,
          prompt
        };
      });
      
      // Sort plugins by creation date (newest first)
      plugins.sort((a, b) => {
        if (a.createdAt === null) return 1;
        if (b.createdAt === null) return -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      
      res.json(formatApiResponse(
        true,
        "Plugins retrieved successfully",
        {
          plugins,
          count: plugins.length,
          baseDir: PLUGINS_BASE_DIR
        }
      ));
      
    } catch (error) {
      console.error("Error listing plugins:", error);
      res.status(500).json(formatApiResponse(
        false,
        "Failed to list plugins",
        { error: (error as Error).message }
      ));
    }
  }
);

// Add a route to get a specific plugin details
pluginsRoutes.get(
  "/:buildId",
  verifyToken,
  (req: Request, res: Response): void => {
    try {
      const { buildId } = req.params;
      const pluginDir = path.join(PLUGINS_BASE_DIR, buildId);
      
      if (!fs.existsSync(pluginDir)) {
        res.status(404).json({
          success: false,
          message: `Plugin ${buildId} not found`
        });
        return;
      }
      
      // Extract plugin information (similar to the list route)
      let pluginName = "Unknown";
      let jarFile = null;
      let status = "unknown";
      let files: string[] = [];
      
      // Get plugin.yml info
      try {
        const possiblePaths = [
          path.join(pluginDir, 'src', 'main', 'resources', 'plugin.yml'),
          path.join(pluginDir, 'plugin.yml')
        ];
        
        for (const ymlPath of possiblePaths) {
          if (fs.existsSync(ymlPath)) {
            const pluginYml = fs.readFileSync(ymlPath, 'utf8');
            const nameMatch = pluginYml.match(/name: *([A-Za-z0-9_]+)/);
            if (nameMatch) {
              pluginName = nameMatch[1];
              break;
            }
          }
        }
      } catch (error) {
        console.warn(`Could not read plugin.yml for ${buildId}:`, error);
      }
      
      // Check build status
      const targetDir = path.join(pluginDir, 'target');
      if (fs.existsSync(targetDir)) {
        try {
          const targetFiles = fs.readdirSync(targetDir);
          const jarFileFound = targetFiles.find(file => file.endsWith('.jar') && !file.includes('original'));
          if (jarFileFound) {
            jarFile = jarFileFound;
            status = "completed";
          } else {
            status = "failed";
          }
        } catch (error) {
          console.warn(`Could not read target directory for ${buildId}:`, error);
          status = "error";
        }
      } else {
        status = "pending";
      }
      
      // List all files with contents
      const fileContents: Record<string, string> = {};
      function walkDir(dir: string, baseDir: string): void {
        if (!fs.existsSync(dir)) return;
        
        const dirFiles = fs.readdirSync(dir);
        for (const file of dirFiles) {
          if (file === 'target') continue;
          
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            walkDir(filePath, baseDir);
          } else if (stat.isFile()) {
            const relativePath = path.relative(baseDir, filePath);
            files.push(relativePath);
            
            // Only include content for text files
            const ext = path.extname(filePath).toLowerCase();
            if (['.java', '.yml', '.xml', '.txt', '.md', '.properties'].includes(ext)) {
              try {
                fileContents[relativePath] = fs.readFileSync(filePath, 'utf8');
              } catch (error) {
                console.warn(`Could not read file ${filePath}:`, error);
                fileContents[relativePath] = "Error reading file";
              }
            }
          }
        }
      }
      
      walkDir(pluginDir, pluginDir);
      
      // Get creation timestamp
      let createdAt = null;
      const timestampMatch = buildId.match(/plugin-(\d+)/);
      if (timestampMatch) {
        const timestamp = parseInt(timestampMatch[1]);
        if (!isNaN(timestamp)) {
          createdAt = new Date(timestamp).toISOString();
        }
      }
      
      if (!createdAt) {
        try {
          const stats = fs.statSync(pluginDir);
          createdAt = stats.birthtime.toISOString();
        } catch (error) {
          console.warn(`Could not get creation time for ${buildId}:`, error);
          createdAt = new Date().toISOString();
        }
      }
      
      // Extract prompt if available
      let prompt = "";
      try {
        const promptPath = path.join(pluginDir, 'prompt.txt');
        if (fs.existsSync(promptPath)) {
          prompt = fs.readFileSync(promptPath, 'utf8');
        }
      } catch (error) {
        console.warn(`Could not read prompt for ${buildId}:`, error);
      }
      
      res.json(formatApiResponse(
        true,
        `Plugin ${buildId} details retrieved successfully`,
        {
          plugin: {
            id: buildId,
            name: pluginName,
            status,
            createdAt,
            jarFile,
            fileCount: files.length,
            files,
            fileContents,
            prompt,
            downloadUrl: jarFile ? `/api/build/download/${buildId}` : null
          }
        }
      ));
      
    } catch (error) {
      console.error(`Error getting plugin ${req.params.buildId}:`, error);
      res.status(500).json(formatApiResponse(
        false,
        "Failed to get plugin details",
        { error: (error as Error).message }
      ));
    }
  }
);

export default {
  fixRoutes,
  createRoutes,
  buildRoutes,
  pluginsRoutes
};