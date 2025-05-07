import express, { Router, Request, Response } from "express";
import { verifyToken } from "../middlewares/authMiddleware";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import crypto from "crypto";
import NodeCache from "node-cache";
import path from "path";

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
    creative: { temperature: 0.5, topP: 0.95, topK: 64 }
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

// Create separate routers
const fixRoutes: Router = express.Router();
const createRoutes: Router = express.Router();

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
    // Get and validate prompt
    const { prompt } = req.body;
    if (!prompt) {
      res.status(400).json({
        status: "fail",
        success: false,
        message: "Request must contain a prompt field",
      });
      return;
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

      // Optimized prompts
      const refiningPrompt = `
        You are a Minecraft plugin requirements analyst. The user has provided this plugin request:
        
        "${prompt}"
        
        Your task is to refine and expand this request into a clear, detailed specification for a Minecraft plugin.
        
        1. Identify what type of plugin is being requested
        2. Add any missing technical details that would be needed for implementation
        3. Clarify ambiguities in the original request
        4. Structure the refined requirements in a way that makes them clear for plugin developers
        5. Add Minecraft/Spigot-specific context where relevant
        6. Ensure all functionality expectations are explicit
        
        Return ONLY the refined, expanded plugin requirements. Do not include explanations about your refinements.
      `;
      
      const blueprintPrompt = `
        You are a Minecraft plugin architect tasked with creating a complete, cohesive plugin blueprint.
        
        PLUGIN REQUIREMENTS:
        ${prompt}
        
        Your task is to create a COMPLETE PLUGIN BLUEPRINT that ensures all files work together consistently.
        
        PART 1: ARCHITECTURE
        - Plugin name and main class
        - Package structure (always use com.pegasus.pluginname format)
        - All required classes with their responsibilities
        - Command structure
        - Event listeners
        - Data storage approach
        
        PART 2: CLASS RELATIONSHIPS
        - Define how classes interact with each other
        - Specify methods that are called between classes
        - Ensure consistent method signatures across all interaction points
        
        PART 3: FILE SPECIFICATIONS
        For EACH file, provide:
        1. File path (e.g. "src/main/java/com/pegasus/pluginname/ClassName.java")
        2. Full class signature
        3. Required imports
        4. Fields/properties with types
        5. Method signatures (parameters and return types)
        6. Brief implementation notes
        
        PART 4: CONFIGURATION
        - Define all plugin.yml entries
        - Specify config.yml structure and default values
        - Any other needed configuration files
        
        FORMAT YOUR RESPONSE AS A STRUCTURED BLUEPRINT THAT CAN BE USED TO GENERATE A FULLY FUNCTIONING PLUGIN.
        DO NOT INCLUDE FULL CODE IMPLEMENTATIONS YET, ONLY STRUCTURED SPECIFICATIONS.
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

      // Extract plugin name with optimized regex matching
      const pluginNameMatch = PLUGIN_NAME_PATTERN.exec(pluginBlueprint) || 
                            PLUGIN_NAME_ALT_PATTERN.exec(pluginBlueprint);
      const pluginName = pluginNameMatch ? pluginNameMatch[1] : "CustomPlugin";

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
      const pluginLower = pluginName.toLowerCase();
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
          
          // Fix main class
          const correctMainClass = `main: com.pegasus.${pluginLower}.Main`;
          if (!fileContent.includes(correctMainClass)) {
            fileContent = fileContent.replace(/main: .*\n/, `${correctMainClass}\n`);
            if (!fileContent.includes("main:")) {
              fileContent += `\n${correctMainClass}`;
            }
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

      // Send the response
      res.status(200).json({
        status: "success",
        success: true,
        message: "Minecraft plugin generated successfully",
        data: files,
        files: Object.keys(files),
        pluginName: pluginName,
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

export default {
  fixRoutes,
  createRoutes,
};