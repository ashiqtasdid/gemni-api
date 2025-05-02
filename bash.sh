#!/bin/bash
# filepath: d:\Codespace\gemin-api\bash.sh

# Check if curl is installed
if ! command -v curl &> /dev/null; then
    echo "Error: curl is required but not installed. Please install curl first."
    echo "You can install it with: sudo apt-get install curl"
    exit 1
fi

# Check if jq is installed (required for JSON parsing)
if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed. Please install jq first."
    echo "You can install it with: sudo apt-get install jq"
    exit 1
fi

# Check if Maven is installed
if ! command -v mvn &> /dev/null; then
    echo "Error: Maven is required but not installed. Please install Maven first."
    echo "You can install it with: sudo apt-get install maven"
    exit 1
fi

# Define API endpoints - use configurable host
API_HOST="${API_HOST:-http://host.docker.internal:5000}"
API_URL="${API_HOST}/api/create"
API_URL_FIX="${API_HOST}/api/fix"

# Handle command line arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 \"<prompt>\" <bearer_token> [output_directory]"
    echo "Example: $0 \"Create a plugin that adds custom food items\" my-token ./my-plugin"
    exit 1
fi

PROMPT="$1"
TOKEN="$2"
OUTPUT_DIR="${3:-.}"  # Default to current directory if not provided

# Convert to absolute path and create directory if it doesn't exist
OUTPUT_DIR="$(realpath -m "$OUTPUT_DIR")"
mkdir -p "$OUTPUT_DIR"

echo "🚀 Generating Minecraft plugin with prompt: $PROMPT"
echo "📁 Files will be saved to: $OUTPUT_DIR"

# Make API request with properly escaped JSON
echo "🔄 Sending request to plugin generation API..."
RESPONSE=$(curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"prompt\": $(jq -R -s . <<< "$PROMPT")}")

# Check if the API request was successful
if echo "$RESPONSE" | jq -e '.status == "success"' > /dev/null; then
    echo "✅ Plugin generated successfully!"
    
    # Extract the data field containing files
    FILES=$(echo "$RESPONSE" | jq '.data')
    
    # Process each file path separately using jq
    for FILE_PATH in $(echo "$FILES" | jq -r 'keys[]'); do
        # Get the file content using jq
        FILE_CONTENT=$(echo "$FILES" | jq -r --arg path "$FILE_PATH" '.[$path]')
        
        # Create the full path
        FULL_PATH="$OUTPUT_DIR/$FILE_PATH"
        
        # Create directory structure if it doesn't exist
        mkdir -p "$(dirname "$FULL_PATH")"
        
        # Write the content to the file without additional cleaning
        # The API already provides clean content
        echo -e "$FILE_CONTENT" > "$FULL_PATH"
        
        echo "📄 Created: $FILE_PATH"
    done
    
    echo "🎉 Plugin files have been successfully created in $OUTPUT_DIR"
    
    # Check if pom.xml exists and build with Maven
    if [ -f "$OUTPUT_DIR/pom.xml" ]; then
        echo "----------------------------------------"
        echo "🔨 Building plugin with Maven..."
        echo "----------------------------------------"
        
        # Save current directory to return later
        CURRENT_DIR=$(pwd)
        
        # Change to the plugin directory
        cd "$OUTPUT_DIR"
        
        # Clean any previous build artifacts first
        echo "🧹 Cleaning previous build artifacts..."
        rm -rf target/
        
        # Build with Maven
        echo "🏗️ Running Maven build..."
        if mvn clean package; then
            echo "----------------------------------------"
            echo "✅ Maven build successful!"
            echo "----------------------------------------"
            
            # Find the generated JAR file
            JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -n 1)
            
            if [ -n "$JAR_FILE" ]; then
                echo "🎮 Plugin JAR file created: $JAR_FILE"
                echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
            else
                echo "⚠️ Plugin JAR file not found in target directory."
            fi
        else
            echo "----------------------------------------"
            echo "❌ Maven build failed. Attempting to fix issues..."
            echo "----------------------------------------"
            
            # Capture the build errors
            BUILD_ERRORS=$(mvn clean compile -e 2>&1)
            
            echo "🔍 Analyzing build errors..."
            
            # Prepare the JSON payload with errors and file contents
            TEMP_JSON_FILE=$(mktemp)
            echo "{" > "$TEMP_JSON_FILE"
            echo "  \"buildErrors\": $(jq -Rs . <<< "$BUILD_ERRORS")," >> "$TEMP_JSON_FILE"
            echo "  \"files\": {" >> "$TEMP_JSON_FILE"
            
            # Add all Java and resource files to the JSON
            FIRST_FILE=true
            
            # Find all Java files, pom.xml, plugin.yml, and config.yml
            find_command="find . -type f -name \"*.java\" -o -name \"pom.xml\" -o -name \"plugin.yml\" -o -name \"config.yml\""
            
            for FILE_PATH in $(eval $find_command); do
                # Get relative path to the output directory
                REL_PATH=$(realpath --relative-to="." "$FILE_PATH")
                
                if [ "$FIRST_FILE" = true ]; then
                    FIRST_FILE=false
                else
                    echo "," >> "$TEMP_JSON_FILE"
                fi
                
                # Add the file content to the JSON
                echo "    \"$REL_PATH\": $(jq -Rs . < "$FILE_PATH")" >> "$TEMP_JSON_FILE"
            done
            
            echo "  }" >> "$TEMP_JSON_FILE"
            echo "}" >> "$TEMP_JSON_FILE"
            
            echo "🔄 Sending build errors to API for fixing..."
            
            # Make API request to fix issues
            FIX_RESPONSE=$(curl -s -X POST "$API_URL_FIX" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $TOKEN" \
                -d @"$TEMP_JSON_FILE")
            
            # Check if the fix API request was successful
            if echo "$FIX_RESPONSE" | jq -e '.status == "success"' > /dev/null; then
                echo "✅ Received fixes from API!"
                
                # Extract the fixed files
                FIXED_FILES=$(echo "$FIX_RESPONSE" | jq '.data')
                
                # Process each fixed file
                for FILE_PATH in $(echo "$FIXED_FILES" | jq -r 'keys[]'); do
                    # Get the file content using jq
                    FILE_CONTENT=$(echo "$FIXED_FILES" | jq -r --arg path "$FILE_PATH" '.[$path]')
                    
                    # Create directory structure if it doesn't exist (for new files)
                    mkdir -p "$(dirname "$FILE_PATH")"
                    
                    # Write the fixed content to the file
                    echo -e "$FILE_CONTENT" > "$FILE_PATH"
                    
                    echo "🔧 Updated: $FILE_PATH"
                done
                
                echo "----------------------------------------"
                echo "🔄 Retrying build with fixed files..."
                echo "----------------------------------------"
                
                # Try to build again with the fixed files
                if mvn clean package; then
                    echo "----------------------------------------"
                    echo "✅ Build successful after fixes!"
                    echo "----------------------------------------"
                    
                    # Find the generated JAR file
                    JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -n 1)
                    
                    if [ -n "$JAR_FILE" ]; then
                        echo "🎮 Plugin JAR file created: $JAR_FILE"
                        echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
                    else
                        echo "⚠️ Plugin JAR file not found in target directory."
                    fi
                else
                    # If still failing, try one more time with all project files
                    echo "----------------------------------------"
                    echo "⚠️ Still having build issues. Trying with comprehensive fix..."
                    echo "----------------------------------------"
                    
                    # Capture all build errors again
                    BUILD_ERRORS=$(mvn clean compile -e 2>&1)
                    
                    # Prepare a more comprehensive JSON payload with ALL files
                    TEMP_JSON_FILE=$(mktemp)
                    echo "{" > "$TEMP_JSON_FILE"
                    echo "  \"buildErrors\": $(jq -Rs . <<< "$BUILD_ERRORS")," >> "$TEMP_JSON_FILE"
                    echo "  \"files\": {" >> "$TEMP_JSON_FILE"
                    
                    # Add ALL Java files and project files to the JSON
                    FIRST_FILE=true
                    for FILE_PATH in $(find . -type f -name "*.java" -o -name "*.xml" -o -name "*.yml"); do
                        # Skip target directory
                        if [[ "$FILE_PATH" == *"target/"* ]]; then
                            continue
                        fi
                        
                        # Get relative path
                        REL_PATH=$(realpath --relative-to="." "$FILE_PATH")
                        
                        if [ "$FIRST_FILE" = true ]; then
                            FIRST_FILE=false
                        else
                            echo "," >> "$TEMP_JSON_FILE"
                        fi
                        
                        # Add the file content to the JSON
                        echo "    \"$REL_PATH\": $(jq -Rs . < "$FILE_PATH")" >> "$TEMP_JSON_FILE"
                    done
                    
                    echo "  }" >> "$TEMP_JSON_FILE"
                    echo "}" >> "$TEMP_JSON_FILE"
                    
                    echo "🔄 Sending comprehensive build data to API for fixing..."
                    
                    # Make API request to fix issues
                    FIX_RESPONSE=$(curl -s -X POST "$API_URL_FIX" \
                        -H "Content-Type: application/json" \
                        -H "Authorization: Bearer $TOKEN" \
                        -d @"$TEMP_JSON_FILE")
                    
                    # Process the comprehensive fix
                    if echo "$FIX_RESPONSE" | jq -e '.status == "success"' > /dev/null; then
                        echo "✅ Received comprehensive fixes!"
                        
                        # Extract and apply all fixed files
                        FIXED_FILES=$(echo "$FIX_RESPONSE" | jq '.data')
                        
                        for FILE_PATH in $(echo "$FIXED_FILES" | jq -r 'keys[]'); do
                            # Get file content
                            FILE_CONTENT=$(echo "$FIXED_FILES" | jq -r --arg path "$FILE_PATH" '.[$path]')
                            
                            # Create directory structure if needed
                            mkdir -p "$(dirname "$FILE_PATH")"
                            
                            # Write the fixed content
                            echo -e "$FILE_CONTENT" > "$FILE_PATH"
                            
                            echo "🔧 Updated: $FILE_PATH"
                        done
                        
                        # Final build attempt
                        echo "----------------------------------------"
                        echo "🔄 Final build attempt with comprehensive fixes..."
                        echo "----------------------------------------"
                        
                        if mvn clean package; then
                            echo "----------------------------------------"
                            echo "✅ Build successful after comprehensive fixes!"
                            echo "----------------------------------------"
                            
                            JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -n 1)
                            
                            if [ -n "$JAR_FILE" ]; then
                                echo "🎮 Plugin JAR file created: $JAR_FILE"
                                echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
                            fi
                        else
                            echo "----------------------------------------"
                            echo "❌ Maven build still failing. Trying simplified build without shading..."
                            echo "----------------------------------------"
                            
                            if mvn clean package -Dmaven.shade.skip=true; then
                                echo "⚠️ Basic build succeeded without shading."
                                JAR_FILE=$(find target -name "*.jar" | head -n 1)
                                if [ -n "$JAR_FILE" ]; then
                                    echo "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                                    echo "Note: This JAR may not include all dependencies."
                                fi
                            else
                                echo "----------------------------------------"
                                echo "❌ All build approaches failed. Manual intervention required."
                                echo "----------------------------------------"
                            fi
                        fi
                    else
                        echo "❌ Fix API couldn't resolve all issues."
                        echo "Attempting simplified build without shading..."
                        
                        if mvn clean package -Dmaven.shade.skip=true; then
                            echo "⚠️ Basic build succeeded without shading."
                            JAR_FILE=$(find target -name "*.jar" | head -n 1)
                            if [ -n "$JAR_FILE" ]; then
                                echo "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                                echo "Note: This JAR may not include all dependencies."
                            fi
                        fi
                    fi
                    
                    # Clean up second temp file
                    rm -f "$TEMP_JSON_FILE"
                fi
            else
                # Display error message if the fix API failed
                ERROR_MSG=$(echo "$FIX_RESPONSE" | jq -r '.message // "Unknown error"')
                echo "❌ Error from fix API: $ERROR_MSG"
                
                # Try with skip shade option as a fallback
                echo "Attempting build with -Dmaven.shade.skip=true..."
                if mvn clean package -Dmaven.shade.skip=true; then
                    echo "⚠️ Basic build succeeded without shading."
                    JAR_FILE=$(find target -name "*.jar" | head -n 1)
                    if [ -n "$JAR_FILE" ]; then
                        echo "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                        echo "Note: This JAR may not include all dependencies."
                    fi
                else
                    echo "----------------------------------------"
                    echo "❌ Maven build failed with all approaches."
                    echo "Common issues to check:"
                    echo "1. Incorrect plugin dependencies"
                    echo "2. Maven Shade Plugin configuration issues"
                    echo "3. Java version compatibility problems"
                    echo "4. File permission issues in the target directory"
                    echo "----------------------------------------"
                fi
            fi
            
            # Clean up temp file
            rm -f "$TEMP_JSON_FILE"
        fi
        
        # Return to original directory
        cd "$CURRENT_DIR"
    else
        echo "⚠️ No pom.xml found in $OUTPUT_DIR. Maven build skipped."
    fi
else
    # Display error message and full response for debugging
    ERROR_MSG=$(echo "$RESPONSE" | jq -r '.message // "Unknown error"')
    echo "❌ Error: $ERROR_MSG"
    echo "Full response: $RESPONSE"
    exit 1
fi

echo "----------------------------------------"
echo "✨ Process completed"
echo "----------------------------------------"