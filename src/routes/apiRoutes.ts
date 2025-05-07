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

// Initialize cache with 1 hour TTL
const pluginCache = new NodeCache({ stdTTL: 3600 });

// Add these interfaces near the top of your file, after your imports
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

// Create separate routers for each feature
const fixRoutes: Router = express.Router();
const createRoutes: Router = express.Router();

// Fix routes - enhanced to handle build failures
fixRoutes.post(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Get JSON data from request body
      const requestData = req.body;
      console.log("Received build error fix request");

      // Validate request body
      if (!requestData || !requestData.buildErrors || !requestData.files) {
        res.status(400).json({
          status: "fail",
          success: false, // For compatibility with the Node script
          message: "Request must contain buildErrors and files fields",
        });
        return;
      }

      console.log("Received build errors for fixing");

      // Check cache for identical build errors
      const cacheKey = crypto.createHash('md5').update(
        requestData.buildErrors + Object.keys(requestData.files).join()
      ).digest('hex');
      
      const cachedResult = pluginCache.get(cacheKey);
      if (cachedResult) {
        console.log("Returning cached fix result");
        res.status(200).json({
          status: "success",
          success: true, // For compatibility with the Node script
          message: "Files fixed successfully (cached)",
          data: cachedResult
        });
        return;
      }

      // Configure the model - Use Flash model for faster response when appropriate
      const flashModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-preview-04-17",
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 64,
        },
      });

      // For complex fixes, use Pro model
      const proModel = genAI.getGenerativeModel({
        model: "gemini-2.5-pro-preview-03-25",
        generationConfig: {
          temperature: 0.1,
          topP: 0.95,
          topK: 64,
        },
      });

      // Extract build errors and files
      const buildErrors = requestData.buildErrors;
      const files = requestData.files;

      // Select appropriate model based on complexity
      const isComplexError = buildErrors.length > 500 || Object.keys(files).length > 5;
      const model = isComplexError ? proModel : flashModel;

      // Optimize prompt by focusing only on files that might be relevant to the error
      const relevantFiles: Record<string, string> = {};
      const errorMentionsFile = (error: string, fileName: string) => 
        error.includes(fileName) || error.toLowerCase().includes(fileName.toLowerCase());
      
      // First pass: include files directly mentioned in errors
      for (const [path, content] of Object.entries(files)) {
        const fileName = path.split('/').pop() || path;
        if (errorMentionsFile(buildErrors, fileName)) {
          relevantFiles[path] = content as string;  // Use type assertion here
        }
      }
      
      // Second pass: if no directly mentioned files, include all
      if (Object.keys(relevantFiles).length === 0) {
        // Use type-safe way to copy properties
        for (const [path, content] of Object.entries(files)) {
          relevantFiles[path] = content as string;
        }
      }
      
      // Always include pom.xml if it exists
      if (files["pom.xml"] && !relevantFiles["pom.xml"]) {
        relevantFiles["pom.xml"] = files["pom.xml"] as string;
      }

      // Let the AI examine all files and errors at once
      const fixPrompt = `
      You are a Minecraft plugin build error expert. A plugin build has failed with the following errors:
      
      BUILD ERRORS:
      ${buildErrors}
      
      Relevant project files are provided below. Analyze the build errors and fix ALL problematic files.
      Pay special attention to XML/POM parsing errors, which often indicate malformed XML.
      
      ${Object.entries(relevantFiles)
        .map(([path, content]) => `FILE: ${path}\n${content}\n\n`)
        .join("---\n")}
      
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

      // Extract the fixed files from the response
      const updatedFiles: Record<string, string> = {};
      const filePattern = /---FILE_START:(.*?)---([\s\S]*?)---FILE_END---/g;
      let fileMatch;

      while ((fileMatch = filePattern.exec(fixedContent)) !== null) {
        const filePath = fileMatch[1].trim();
        let content = fileMatch[2].trim();

        // Efficient cleaning in one pass
        content = content
          .replace(/^```(?:java|xml|yml|yaml)?\s*\n?/i, "")
          .replace(/\n?```\s*$/g, "")
          .replace(/```/g, "");

        // For Java files, check for common API errors
        if (filePath.endsWith(".java")) {
          // Batch all replacements
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

      // Send the fixed files as the API response in a format compatible with the Node script
      res.status(200).json({
        status: "success",
        success: true, // For compatibility with the Node script
        message: "Files fixed successfully",
        data: updatedFiles,
        changedFiles: Object.keys(updatedFiles).length
      });
    } catch (error) {
      console.error("Error fixing build issues:", error);
      res.status(500).json({
        status: "error",
        success: false, // For compatibility with the Node script
        message: "Failed to fix build issues",
        error: (error as Error).message,
      });
    }
  }
);

// Create routes with Blueprint-based plugin generation
createRoutes.post(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    // Get JSON data from request body
    const requestData = req.body;

    // Log for debugging
    console.log("Received plugin generation request");

    // Validate request body contains prompt field
    if (!requestData || !requestData.prompt) {
      res.status(400).json({
        status: "fail",
        success: false, // For compatibility with the Node script
        message: "Request must contain a prompt field",
      });
      return;
    }

    try {
      // Check cache for similar requests
      const cacheKey = crypto.createHash('md5').update(requestData.prompt).digest('hex');
      const cachedResult = pluginCache.get(cacheKey);

      if (cachedResult) {
        console.log("Returning cached plugin result");
        
        // Format response to match what the Node script expects
        const pluginName = Object.keys(cachedResult).find(file => file.endsWith('.java'))?.split('/').pop()?.replace('.java', '') || 'Plugin';
        
        res.status(200).json({
          status: "success",
          success: true, // For compatibility with the Node script
          message: "Minecraft plugin generated successfully (cached)",
          data: cachedResult,
          pluginName: pluginName,
          files: Object.keys(cachedResult)
        });
        return;
      }

      const startTime = Date.now();

      // Configure models upfront for reuse
      const proModel = genAI.getGenerativeModel({
        model: "gemini-2.5-pro-preview-03-25",
        generationConfig: {
          temperature: 0.2,
          topP: 0.95,
          topK: 64,
        },
      });

      const flashModel = genAI.getGenerativeModel({
        model: "gemini-2.5-flash-preview-04-17",
        generationConfig: {
          temperature: 0.5,
          topP: 0.95,
          topK: 64,
        },
      });

      // PHASE 1: Prepare prompts for parallel execution
      console.log("Preparing prompts for parallel execution...");
      
      const refiningPrompt = `
        You are a Minecraft plugin requirements analyst. The user has provided this plugin request:
        
        "${requestData.prompt}"
        
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
        ${requestData.prompt}
        
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

      // PHASE 1 & 2: Run requirements refinement and blueprint generation in parallel
      console.log("Starting parallel blueprint and requirements refinement...");
      const [refinedPromptResult, blueprintResult] = await Promise.all([
        flashModel.generateContent(refiningPrompt),
        flashModel.generateContent(blueprintPrompt)
      ]);

      const refinedPrompt = await refinedPromptResult.response.text();
      const pluginBlueprint = await blueprintResult.response.text();
      console.log("Parallel generation complete");

      // Extract plugin name from blueprint for later use
      const pluginNameMatch = pluginBlueprint.match(/Plugin name:?\s*([A-Za-z0-9_]+)/i) || 
                             pluginBlueprint.match(/Name:?\s*([A-Za-z0-9_]+)\s*plugin/i);
      const pluginName = pluginNameMatch ? pluginNameMatch[1] : "CustomPlugin";

      // PHASE 3: File List Extraction - use a more focused, concise prompt
      console.log("Extracting file list...");
      const fileListPrompt = `
        Based on this plugin blueprint, extract ONLY a JSON array of all files to create:
        
        ${pluginBlueprint.substring(0, 5000)}
        
        Return ONLY a valid JSON array like this: ["pom.xml", "plugin.yml", "Main.java", ...].
        Include pom.xml, plugin.yml, and all Java class files. Return ONLY the JSON array.
      `;

      const fileListResult = await flashModel.generateContent(fileListPrompt);
      const fileListText = await fileListResult.response.text();

      // Extract JSON array from response with improved validation
      let fileStructure: string[] = [];
      try {
        // Find anything that looks like a JSON array
        const match = fileListText.match(/\[\s*"[^"]+(?:",\s*"[^"]+")*\s*\]/);
        if (match) {
          fileStructure = JSON.parse(match[0]);
          
          // Validate paths and fix if necessary
          fileStructure = fileStructure.map(path => {
            // Ensure Java files are in correct directory structure if not already
            if (path.endsWith(".java") && !path.includes("/")) {
              return `src/main/java/com/pegasus/${pluginName.toLowerCase()}/${path}`;
            }
            // Ensure resource files are in the right place
            if ((path === "plugin.yml" || path === "config.yml") && !path.includes("/")) {
              return `src/main/resources/${path}`;
            }
            return path;
          });
        } else {
          throw new Error("Could not extract file structure");
        }
      } catch (e) {
        console.warn("Error parsing file structure, using default structure", e);
        // Create default structure using the extracted plugin name
        fileStructure = [
          "pom.xml",
          "src/main/resources/plugin.yml",
          `src/main/java/com/pegasus/${pluginName.toLowerCase()}/Main.java`,
        ];
      }

      console.log("Files to generate:", fileStructure);

      // PHASE 4: Code Generation
      console.log("Generating all plugin files together...");
      
      // Optimize the prompt to be more concise and focused
      const multiFileGenPrompt = `
        Implement a complete Minecraft plugin based on:
        
        BLUEPRINT:
        ${pluginBlueprint}
        
        PLUGIN NAME: ${pluginName}
        
        FILES TO CREATE:
        ${fileStructure.join("\n")}
        
        GUIDELINES:
        - Always use "com.pegasus.${pluginName.toLowerCase()}" as root package
        - Follow blueprint class relationships exactly
        - No JetBrains annotations (@NotNull, @Nullable)
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

      // Extract all files from the response with optimized processing
      const files: Record<string, string> = {};
      const filePattern = /---FILE_START:(.*?)---([\s\S]*?)---FILE_END---/g;
      let fileMatch;

      while ((fileMatch = filePattern.exec(multiFileResponse)) !== null) {
        const filePath = fileMatch[1].trim();
        let fileContent = fileMatch[2].trim();

        // Clean content in one pass with combined regex
        fileContent = fileContent
          .replace(/^```(?:java|xml|yml|yaml)?\s*\n?/i, "")
          .replace(/\n?```\s*$/g, "")
          .replace(/```/g, "");

        // Process different file types efficiently
        if (filePath.endsWith(".java")) {
          // Process Java files
          fileContent = fileContent
            // Fix invalid API calls
            .replace(/pig\.setAngry\(([^)]+)\)/g, 
              '// Pig.setAngry() doesn\'t exist in Bukkit API \n    pig.setPersistent(true);\n    pig.setCustomName("Angry Pig");\n    pig.setMetadata("angry", new FixedMetadataValue(plugin, true));')
            // Add metadata import if needed
            .replace(/(import .+;\n\n)/, function(match) {
              return fileContent.includes("setMetadata") && !fileContent.includes("import org.bukkit.metadata.FixedMetadataValue") 
                ? match + "import org.bukkit.metadata.FixedMetadataValue;\n" 
                : match;
            })
            // Remove JetBrains annotations in one pass
            .replace(/import org\.jetbrains\.annotations\.[^;]*;(\r?\n|\r)?/g, "")
            .replace(/@NotNull |@Nullable /g, "");
          
          // Handle package declarations
          const packageMatch = filePath.match(/src\/main\/java\/(.*\/)/);
          if (packageMatch) {
            const packageName = packageMatch[1].replace(/\//g, ".").replace(/\.$/, "");
            const packageRegex = /^package .*?;(\r?\n|\r)+/;
            const cleanedContent = fileContent.replace(packageRegex, "");
            
            fileContent = cleanedContent.trim().startsWith("package") 
              ? cleanedContent 
              : `package ${packageName};\n\n${cleanedContent}`;
          }
        } else if (filePath === "pom.xml" || filePath.endsWith(".xml")) {
          // Process XML files
          fileContent = fileContent.replace(/^[^<]*(<\?xml|<project)/, "$1");
          if (!fileContent.startsWith("<?xml")) {
            fileContent = '<?xml version="1.0" encoding="UTF-8"?>\n' + fileContent;
          }
          
          // Make sure artifactId uses the plugin name
          if (!fileContent.includes(`<artifactId>${pluginName.toLowerCase()}</artifactId>`)) {
            fileContent = fileContent.replace(
              /<artifactId>(.*?)<\/artifactId>/,
              `<artifactId>${pluginName.toLowerCase()}</artifactId>`
            );
          }
        } else if (filePath.endsWith("plugin.yml")) {
          // Ensure plugin.yml has the correct name
          if (!fileContent.includes(`name: ${pluginName}`)) {
            fileContent = fileContent.replace(/name: .*/, `name: ${pluginName}`);
            if (!fileContent.includes("name:")) {
              fileContent = `name: ${pluginName}\n${fileContent}`;
            }
          }
          
          // Ensure main class path is correct
          const mainClassRegex = /main: .*?\n/;
          const correctMainClass = `main: com.pegasus.${pluginName.toLowerCase()}.Main`;
          if (fileContent.match(mainClassRegex)) {
            fileContent = fileContent.replace(mainClassRegex, `main: com.pegasus.${pluginName.toLowerCase()}.Main\n`);
          } else if (!fileContent.includes("main:")) {
            fileContent += `\nmain: com.pegasus.${pluginName.toLowerCase()}.Main`;
          }
        }

        // Replace any yourusername with pegasus and ensure package names match plugin name
        fileContent = fileContent
          .replace(/com\.yourusername/g, `com.pegasus.${pluginName.toLowerCase()}`)
          .replace(/com\.pegasus\.plugin/g, `com.pegasus.${pluginName.toLowerCase()}`)
          .replace(/yourusername/g, "pegasus");

        files[filePath] = fileContent;
        console.log(`Extracted file: ${filePath}`);
      }

      // If no files were extracted, fall back to individual generation
      if (Object.keys(files).length === 0) {
        console.warn("Failed to extract files from multi-file generation, falling back to standard approach");
        
        // Simplified individual file generation using the blueprint directly
        for (const filePath of fileStructure) {
          console.log(`Generating individual file: ${filePath}`);
          
          const singleFilePrompt = `
            Create a single Minecraft plugin file based on this blueprint:
            
            ${pluginBlueprint}
            
            PLUGIN NAME: ${pluginName}
            
            Generate ONLY this file: ${filePath}
            
            Use package: com.pegasus.${pluginName.toLowerCase()}
            
            Return the complete implementation of the file. NO explanations or markdown, JUST the file content.
          `;
          
          const singleFileResult = await flashModel.generateContent(singleFilePrompt);
          const singleFileContent = await singleFileResult.response.text();
          
          // Clean the response
          let fileContent = singleFileContent
            .replace(/^```(?:java|xml|yml|yaml)?\s*\n?/i, "")
            .replace(/\n?```\s*$/g, "")
            .replace(/```/g, "");
            
          files[filePath] = fileContent;
        }
      }

      // PHASE 5: Cross-file validation with optimized prompt
      console.log("Performing cross-file validation...");
      const validationPrompt = `
        Check these Minecraft plugin files for consistency issues:
        
        ${Object.entries(files)
          .map(([path, content]) => `${path}:\n${content.substring(0, 200)}...[truncated]`)
          .join("\n\n")}
        
        Focus ONLY on critical issues: method signature mismatches, inconsistent package names,
        and missing class imports.
        
        Return ONLY JSON: {"status": "consistent"} or {"issues": [{
          "fileA": "path1",
          "fileB": "path2", 
          "issue": "description", 
          "fix": "solution"
        }]}
      `;

      const validationResult = await flashModel.generateContent(validationPrompt);
      const validationText = await validationResult.response.text();

      let inconsistencies: InconsistencyResponse = {};
      try {
        const match = validationText.match(/\{[\s\S]*\}/);
        if (match) {
          inconsistencies = JSON.parse(match[0]);
        }
      } catch (e) {
        console.warn("Error parsing validation results, proceeding with generation", e);
      }

      // Phase 6: Fix inconsistencies programmatically where possible
      if (Object.keys(inconsistencies).length > 0 && !("status" in inconsistencies)) {
        console.log("Fixing inconsistencies between files programmatically...");

        // Properly handled typed array of issues
        let issues: InconsistencyIssue[] = [];
        
        if (inconsistencies.issues && Array.isArray(inconsistencies.issues)) {
          issues = inconsistencies.issues;
        } else {
          // Cast the object to any before extracting values to avoid TypeScript errors
          const incObj = inconsistencies as any;
          issues = Object.values(incObj);
        }

        for (const issue of issues) {
          const fileA = issue.fileA;
          const fileB = issue.fileB;
          
          console.log(`Fixing inconsistency between ${fileA} and ${fileB}`);
          
          // Simple pattern-based fixes
          if (issue.issue.toLowerCase().includes("package")) {
            // Fix package inconsistencies
            const correctPackageMatch = issue.fix.match(/should be ['"]([^'"]+)['"]/);
            if (correctPackageMatch) {
              const correctPackage = correctPackageMatch[1];
              
              // Fix package declaration
              files[fileA] = files[fileA].replace(/package\s+[^;]+;/, `package ${correctPackage};`);
              files[fileB] = files[fileB].replace(/package\s+[^;]+;/, `package ${correctPackage};`);
              
              // Fix imports referencing these packages
              const oldPackageMatch = issue.issue.match(/['"]([^'"]+)['"]\s+vs\s+['"]([^'"]+)['"]/);
              if (oldPackageMatch) {
                const wrongPackage = issue.issue.includes(fileA) ? oldPackageMatch[1] : oldPackageMatch[2];
                
                // Replace wrong package in import statements
                for (const file in files) {
                  files[file] = files[file].replace(
                    new RegExp(`import\\s+${wrongPackage}\\.`, 'g'), 
                    `import ${correctPackage}.`
                  );
                }
              }
            }
          } else if (issue.issue.toLowerCase().includes("method signature") || 
                    issue.issue.toLowerCase().includes("parameter")) {
            // For complex method signature mismatches, use the flash model
            const fixPrompt = `
              Fix this method signature inconsistency:
              ISSUE: ${issue.issue}
              FIX: ${issue.fix}
              
              File A (${fileA}):
              ${files[fileA].substring(0, 300)}
              
              File B (${fileB}):
              ${files[fileB].substring(0, 300)}
              
              Return ONLY the correct method signature that should be used in both files.
            `;
            
            const fixResult = await flashModel.generateContent(fixPrompt);
            const fixText = await fixResult.response.text();
            
            // Extract the corrected method signature
            const methodMatch = fixText.match(/(?:public|private|protected)[\s\S]+?;/);
            if (methodMatch) {
              const correctSignature = methodMatch[0];
              const methodName = correctSignature.match(/\s(\w+)\s*\(/)?.[1];
              
              if (methodName) {
                // Replace the method signatures in both files
                const methodRegex = new RegExp(
                  `(?:public|private|protected)[\\s\\S]+?${methodName}\\s*\\([\\s\\S]+?\\)\\s*\\{`, 'g'
                );
                
                files[fileA] = files[fileA].replace(methodRegex, 
                  correctSignature.replace(/;$/, "") + " {"
                );
                
                files[fileB] = files[fileB].replace(methodRegex, 
                  correctSignature.replace(/;$/, "") + " {"
                );
              }
            }
          }
        }
      }

      // Final cleanup pass
      console.log("Performing final cleanup...");
      for (const filePath in files) {
        // Batch replacements for efficiency
        files[filePath] = files[filePath]
          .replace(/com\.yourusername/g, `com.pegasus.${pluginName.toLowerCase()}`)
          .replace(/com\.pegasus\.plugin/g, `com.pegasus.${pluginName.toLowerCase()}`)
          .replace(/yourusername/g, "pegasus")
          .replace(/@NotNull |@Nullable /g, "");
          
        // Specific Java import fixes
        if (filePath.endsWith(".java")) {
          const lines = files[filePath].split("\n");
          const fixedLines = lines.map(line => {
            if (line.startsWith("import ") && line.includes(".yourusername.")) {
              return line.replace(".yourusername.", ".pegasus.");
            }
            return line;
          });
          files[filePath] = fixedLines.join("\n");
        }
      }

      // Calculate approximate JAR path for response (this is what the bash script would create)
      const jarPath = `target/${pluginName.toLowerCase()}-1.0-SNAPSHOT.jar`;
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

      // Cache the result
      pluginCache.set(cacheKey, files);

      // Send the generated files as response in a format compatible with the Node script
      res.status(200).json({
        status: "success",
        success: true, // For compatibility with the Node script
        message: "Minecraft plugin generated successfully",
        data: files,
        files: Object.keys(files),
        pluginName: pluginName,
        jarPath: jarPath,
        processingTime: `${processingTime}s`,
        // The following fields are included for compatibility with your Node.js script
        outputDir: "", // This will be set by the node script
        log: `Processed plugin generation in ${processingTime} seconds. Generated ${Object.keys(files).length} files.`,
      });
    } catch (error) {
      console.error("Error generating Minecraft plugin:", error);
      res.status(500).json({
        status: "error",
        success: false, // For compatibility with the Node script
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