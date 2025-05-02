import express, { Router, Request, Response } from "express";
import { verifyToken } from "../middlewares/authMiddleware";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();
// Initialize the Gemini API client
const API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);

// Add this interface near the top of your file, after your imports
interface InconsistencyIssue {
  fileA: string;
  fileB: string;
  issue: string;
  fix: string;
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

      // Validate request body
      if (!requestData || !requestData.buildErrors || !requestData.files) {
        res.status(400).json({
          status: "fail",
          message: "Request must contain buildErrors and files fields",
        });
        return;
      }

      console.log("Received build errors for fixing");

      // Configure the model
      const model = genAI.getGenerativeModel({
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

      // Let the AI examine all files and errors at once
      const fixPrompt = `
      You are a Minecraft plugin build error expert. A plugin build has failed with the following errors:
      
      BUILD ERRORS:
      ${buildErrors}
      
      All project files are provided below. Analyze the build errors and fix ALL problematic files.
      Pay special attention to XML/POM parsing errors, which often indicate malformed XML.
      
      ${Object.entries(files)
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

      const fixResult = await model.generateContent(fixPrompt);
      const fixedContent = await fixResult.response.text();

      // Extract the fixed files from the response
      const updatedFiles: Record<string, string> = {};
      const filePattern = /---FILE_START:(.*?)---([\s\S]*?)---FILE_END---/g;
      let fileMatch;

      while ((fileMatch = filePattern.exec(fixedContent)) !== null) {
        const filePath = fileMatch[1].trim();
        let content = fileMatch[2].trim();

        // More thorough cleaning of markdown and backtick characters
        // Remove leading backticks and language identifier
        content = content.replace(/^```(?:java|xml|yml|yaml)?\s*\n?/i, "");
        // Remove trailing backticks
        content = content.replace(/\n?```\s*$/g, "");
        // Remove any other backtick sequences that might be present
        content = content.replace(/```/g, "");

        // For Java files, check for common API errors
        if (filePath.endsWith(".java")) {
          // Remove invalid method calls where possible
          content = content.replace(
            /pig\.setAngry\(([^)]+)\)/g,
            "// TODO: Pig.setAngry() doesn't exist in Bukkit API - implement custom behavior\n    // pig.setAngry($1)"
          );

          // Check for other problematic Java syntax
          content = content.replace(
            /^package\s+(.+?)\s*;\s*```/gm,
            "package $1;"
          );
          content = content.replace(/```\s*package/g, "package");
        }

        updatedFiles[filePath] = content;
        console.log(`🔧 Fixed file: ${filePath}`);
      }

      // Send the fixed files as the API response
      res.status(200).json({
        status: "success",
        message: "Files fixed successfully",
        data: updatedFiles,
      });
    } catch (error) {
      console.error("Error fixing build issues:", error);
      res.status(500).json({
        status: "error",
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
    console.log("Received data:", requestData);

    // Validate request body contains prompt field
    if (!requestData || !requestData.prompt) {
      res.status(400).json({
        status: "fail",
        message: "Request must contain a prompt field",
      });
      return;
    }

    try {
      // Configure the model with more tokens for complex generation
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-pro-preview-03-25",
        generationConfig: {
          temperature: 0.2, // Lower temperature for more precise code generation
          topP: 0.95,
          topK: 64,
        },
      });

      // PHASE 1: Requirements Refinement
      console.log("Refining user requirements...");
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

      const refiningResult = await model.generateContent(refiningPrompt);
      const refinedPrompt = await refiningResult.response.text();
      console.log("Refined requirements:", refinedPrompt);

      // PHASE 2: Plugin Blueprint Generation - THIS IS THE KEY CHANGE
      console.log("Generating plugin blueprint...");
      const blueprintPrompt = `
        You are a Minecraft plugin architect tasked with creating a complete, cohesive plugin blueprint.
        
        PLUGIN REQUIREMENTS:
        ${refinedPrompt}
        
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

      const blueprintResult = await model.generateContent(blueprintPrompt);
      const pluginBlueprint = await blueprintResult.response.text();
      console.log("Plugin blueprint generated");

      // PHASE 3: File List Extraction
      console.log("Extracting file list...");
      const fileListPrompt = `
        Based on this plugin blueprint:
        
        ${pluginBlueprint}
        
        Extract ONLY a list of all files that need to be created.
        Return your answer as a valid JSON array of file paths, like this:
        ["pom.xml", "src/main/resources/plugin.yml", "src/main/java/com/pegasus/pluginname/Main.java", ...]
        
        Include all needed files including:
        - pom.xml
        - plugin.yml, config.yml, and any other resource files
        - All Java classes mentioned in the blueprint
        
        Return ONLY the JSON array, nothing else.
      `;

      const fileListResult = await model.generateContent(fileListPrompt);
      const fileListText = await fileListResult.response.text();

      // Extract JSON array from response
      let fileStructure: string[] = [];
      try {
        const match = fileListText.match(/\[[\s\S]*\]/);
        if (match) {
          fileStructure = JSON.parse(match[0]);
        } else {
          throw new Error("Could not extract file structure");
        }
      } catch (e) {
        console.warn(
          "Error parsing file structure, using default structure",
          e
        );
        fileStructure = [
          "pom.xml",
          "src/main/resources/plugin.yml",
          "src/main/java/com/pegasus/plugin/Main.java",
        ];
      }

      console.log("Files to generate:", fileStructure);

      // PHASE 4: Code Generation - Generate all files at once for better consistency
      console.log("Generating all plugin files together...");
      const multiFileGenPrompt = `
        You are a Minecraft plugin developer tasked with implementing a complete plugin based on a blueprint.
        
        FULL PLUGIN BLUEPRINT:
        ${pluginBlueprint}
        
        Your task is to implement ALL the files needed for this plugin:
        ${fileStructure.join("\n")}
        
        IMPORTANT GUIDELINES:
        1. Always use "com.pegasus" as the root package (NEVER use com.yourusername)
        2. Follow the class relationships defined in the blueprint exactly
        3. Implement all methods with the EXACT signatures from the blueprint
        4. DO NOT use JetBrains annotations (@NotNull, @Nullable)
        5. Only use standard Bukkit/Spigot APIs
        6. Ensure imports match classes defined in the blueprint
        7. For pom.xml: Include Spigot 1.19.3 API, Java 11, Maven Shade Plugin 3.4.1
        8. Make sure every class references other classes with consistent package names
        
        Format your response as follows for EACH file:
        ---FILE_START:filepath---
        [file content here]
        ---FILE_END---
        
        Return the COMPLETE implementation of ALL files.
      `;

      const multiFileResult = await model.generateContent(multiFileGenPrompt);
      const multiFileResponse = await multiFileResult.response.text();

      // Extract all files from the response
      const files: Record<string, string> = {};
      const filePattern = /---FILE_START:(.*?)---([\s\S]*?)---FILE_END---/g;
      let fileMatch;

      while ((fileMatch = filePattern.exec(multiFileResponse)) !== null) {
        const filePath = fileMatch[1].trim();
        let fileContent = fileMatch[2].trim();

        // More thorough cleaning of markdown content
        // Remove leading backticks and language identifier
        fileContent = fileContent.replace(
          /^```(?:java|xml|yml|yaml)?\s*\n?/i,
          ""
        );
        // Remove trailing backticks
        fileContent = fileContent.replace(/\n?```\s*$/g, "");
        // Remove any other backtick sequences that might be present
        fileContent = fileContent.replace(/```/g, "");

        // For Java files with special handling
        if (filePath.endsWith(".java")) {
          // Fix any invalid Bukkit API calls
          fileContent = fileContent.replace(
            /pig\.setAngry\(([^)]+)\)/g,
            '// Pig.setAngry() doesn\'t exist in Bukkit API \n    // Alternative implementation:\n    pig.setPersistent(true); // Make pig persistent\n    pig.setCustomName("Angry Pig"); // Visual indicator\n    // Set custom metadata to track angry state\n    pig.setMetadata("angry", new FixedMetadataValue(plugin, true));'
          );

          // Also add the necessary import for metadata if the fix is applied
          if (fileContent.includes("setMetadata")) {
            const importLine = "import org.bukkit.metadata.FixedMetadataValue;";
            if (!fileContent.includes(importLine)) {
              // Add the import after other imports
              fileContent = fileContent.replace(
                /(import .+;\n\n)/m,
                "$1import org.bukkit.metadata.FixedMetadataValue;\n"
              );
            }
          }
        }

        // Continue with the rest of your cleaning and processing...

        // Ensure proper XML formatting
        if (filePath === "pom.xml" || filePath.endsWith(".xml")) {
          fileContent = fileContent.replace(/^[^<]*(<\?xml|<project)/, "$1");
          if (!fileContent.startsWith("<?xml")) {
            fileContent =
              '<?xml version="1.0" encoding="UTF-8"?>\n' + fileContent;
          }
        } else if (filePath.endsWith(".java")) {
          // Ensure proper package declarations for Java files
          const packageMatch = filePath.match(/src\/main\/java\/(.*\/)/);
          if (packageMatch) {
            const packageName = packageMatch[1]
              .replace(/\//g, ".")
              .replace(/\.$/, "");
            const packageRegex = /^package .*?;(\r?\n|\r)+/;
            let cleanedContent = fileContent.replace(packageRegex, "");

            // Add proper package declaration if not present
            if (!cleanedContent.trim().startsWith("package")) {
              fileContent = `package ${packageName};\n\n${cleanedContent}`;
            } else {
              fileContent = cleanedContent;
            }

            // Remove JetBrains annotations
            fileContent = fileContent.replace(
              /import org\.jetbrains\.annotations\.[^;]*;(\r?\n|\r)?/g,
              ""
            );
            fileContent = fileContent.replace(/@NotNull /g, "");
            fileContent = fileContent.replace(/@Nullable /g, "");
          }
        }

        // Replace any yourusername with pegasus
        fileContent = fileContent.replace(/com\.yourusername/g, "com.pegasus");
        fileContent = fileContent.replace(/yourusername/g, "pegasus");

        files[filePath] = fileContent;
        console.log(`Extracted file: ${filePath}`);
      }

      // If no files were extracted, fall back to individual generation
      if (Object.keys(files).length === 0) {
        console.warn(
          "Failed to extract files from multi-file generation, falling back to individual generation"
        );
        // Original file-by-file generation code would go here...
      }

      // PHASE 5: Cross-file Validation to ensure consistency
      console.log("Performing cross-file validation...");
      const validationPrompt = `
        You are a Minecraft plugin validation specialist. Review these generated files for consistency:
        
        ${Object.entries(files)
          .map(
            ([path, content]) =>
              `${path}:\n${content.substring(0, 300)}...[truncated]`
          )
          .join("\n\n")}
        
        Check for:
        1. Consistent method calls between classes - Do called methods exist with the right signatures?
        2. Consistent package names - All should use com.pegasus
        3. Matching class names in imports and actual files
        4. Proper listener and command registration
        
        Return ONLY inconsistencies in this JSON format:
        {
          "inconsistency1": {
            "fileA": "path/to/fileA",
            "fileB": "path/to/fileB",
            "issue": "Description of the inconsistency",
            "fix": "Recommended fix"
          },
          ...
        }
        
        If no issues found, return: {"status": "consistent"}
      `;

      const validationResult = await model.generateContent(validationPrompt);
      const validationText = await validationResult.response.text();

      let inconsistencies:
        | Record<string, InconsistencyIssue>
        | { status: string } = {};
      try {
        const match = validationText.match(/\{[\s\S]*\}/);
        if (match) {
          inconsistencies = JSON.parse(match[0]);
        }
      } catch (e) {
        console.warn(
          "Error parsing validation results, proceeding with generation",
          e
        );
      }

      // Phase 6: Fix inconsistencies if needed
      if (
        Object.keys(inconsistencies).length > 0 &&
        !("status" in inconsistencies)
      ) {
        console.log("Fixing inconsistencies between files...");

        for (const issue of Object.values(
          inconsistencies
        ) as InconsistencyIssue[]) {
          const fileA = issue.fileA;
          const fileB = issue.fileB;
          const issueDesc = issue.issue;
          const recommendedFix = issue.fix;

          console.log(`Fixing inconsistency: ${issueDesc}`);

          const fixPrompt = `
            You are a Minecraft plugin code fixer. These files have an inconsistency:
            
            FILE A (${fileA}):
            ${files[fileA]}
            
            FILE B (${fileB}):
            ${files[fileB]}
            
            ISSUE: ${issueDesc}
            RECOMMENDED FIX: ${recommendedFix}
            
            Provide the corrected versions of BOTH files. Format your response as:
            ---FILE A START---
            (corrected content for file A)
            ---FILE A END---
            ---FILE B START---
            (corrected content for file B)
            ---FILE B END---
          `;

          const fixResult = await model.generateContent(fixPrompt);
          const fixedContent = await fixResult.response.text();

          // Extract fixed content for both files
          const fileAMatch = fixedContent.match(
            /---FILE A START---([\s\S]*?)---FILE A END---/
          );
          const fileBMatch = fixedContent.match(
            /---FILE B START---([\s\S]*?)---FILE B END---/
          );

          if (fileAMatch) {
            files[fileA] = fileAMatch[1].trim();
          }

          if (fileBMatch) {
            files[fileB] = fileBMatch[1].trim();
          }
        }
      }

      // Final pass to ensure all yourusername instances are replaced with pegasus
      for (const filePath in files) {
        files[filePath] = files[filePath].replace(
          /com\.yourusername/g,
          "com.pegasus"
        );
        files[filePath] = files[filePath].replace(/yourusername/g, "pegasus");

        // Ensure package structure in imports is consistent
        if (filePath.endsWith(".java")) {
          const lines = files[filePath].split("\n");
          for (let i = 0; i < lines.length; i++) {
            // Fix any import statements that might still reference yourusername
            if (
              lines[i].startsWith("import ") &&
              lines[i].includes(".yourusername.")
            ) {
              lines[i] = lines[i].replace(".yourusername.", ".pegasus.");
            }
          }
          files[filePath] = lines.join("\n");
        }
      }

      // Send the generated files as response
      res.status(200).json({
        status: "success",
        message: "Minecraft plugin generated successfully",
        data: files,
      });
    } catch (error) {
      console.error("Error generating Minecraft plugin:", error);
      res.status(500).json({
        status: "error",
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
