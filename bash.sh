#!/bin/bash
export PATH="/usr/bin:/usr/local/bin:/bin:/sbin:/usr/sbin:$PATH"

# Set up trap to clean temporary files on exit
cleanup() {
    echo "🧹 Cleaning up temporary files..."
    [ -n "$TEMP_JSON_FILE" ] && [ -f "$TEMP_JSON_FILE" ] && rm -f "$TEMP_JSON_FILE"
    [ -n "$CURRENT_DIR" ] && [ "$PWD" != "$CURRENT_DIR" ] && cd "$CURRENT_DIR"
}
trap cleanup EXIT INT TERM

# Print PATH for debugging
echo "Current PATH: $PATH"

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

# Load configuration if exists
CONFIG_FILE="$HOME/.minecraft_plugin_generator.conf"
if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
    echo "📝 Loaded configuration from $CONFIG_FILE"
fi

# Define API endpoints - use configurable host
# Default to Docker bridge network gateway for container-to-container communication
API_HOST="${API_HOST:-http://172.17.0.1:5000}"
API_URL="${API_HOST}/api/create"
API_URL_FIX="${API_HOST}/api/fix"

echo "🔌 Using API endpoint: $API_HOST"

# Test API connection before proceeding
echo "🔍 Testing connection to API endpoint..."
if curl -s --connect-timeout 5 --max-time 10 -I "$API_HOST" &>/dev/null; then
    echo "✅ API host is reachable"
else
    echo "⚠️ Warning: Cannot reach API host directly. This might be normal in some Docker setups."
    echo "ℹ️ Proceeding with the API request anyway..."
fi

# Handle command line arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 \"<prompt>\" <bearer_token> [output_directory]"
    echo "Example: $0 \"Create a plugin that adds custom food items\" my-token ./my-plugin"
    exit 1
fi

PROMPT="$1"
TOKEN="$2"
BASE_OUTPUT_DIR="${3:-.}"  # Default to current directory if not provided

# Make the realpath command cross-platform compatible
if command -v realpath &> /dev/null; then
    BASE_OUTPUT_DIR="$(realpath -m "$BASE_OUTPUT_DIR")"
else
    # Fallback for Windows systems without realpath
    BASE_OUTPUT_DIR="$(cd "$BASE_OUTPUT_DIR" 2>/dev/null || mkdir -p "$BASE_OUTPUT_DIR" && cd "$BASE_OUTPUT_DIR" && pwd)"
fi
mkdir -p "$BASE_OUTPUT_DIR"

# Generate plugin folder name from prompt
# Extract basic name or use default if can't derive sensible name
PLUGIN_NAME=$(echo "$PROMPT" | tr -cs '[:alnum:]' ' ' | awk '{print $1$2}' | sed 's/[^a-zA-Z0-9]//g')
if [ -z "$PLUGIN_NAME" ] || [ ${#PLUGIN_NAME} -lt 3 ]; then
    PLUGIN_NAME="MinecraftPlugin"
fi
PLUGIN_NAME="${PLUGIN_NAME}Plugin"

# Create dedicated plugin folder
OUTPUT_DIR="$BASE_OUTPUT_DIR/$PLUGIN_NAME"
mkdir -p "$OUTPUT_DIR"

echo "🚀 Generating Minecraft plugin with prompt: $PROMPT"
echo "📁 Files will be saved to: $OUTPUT_DIR"

# Make API request with properly escaped JSON
echo "🔄 Sending request to plugin generation API (this may take a few minutes)..."
RESPONSE=$(curl -s --connect-timeout 30 --max-time 600 -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"prompt\": $(jq -R -s . <<< "$PROMPT")}" 2>/dev/null)

# Validate API response
if [ -z "$RESPONSE" ]; then
    echo "❌ Error: Empty response from API. Check your network connection and Docker setup."
    echo "ℹ️ If this keeps failing, try one of these options:"
    echo "   1. Edit $CONFIG_FILE and set API_HOST=http://localhost:5000"
    echo "   2. Or try: API_HOST=http://host.docker.internal:5000 $0 \"$PROMPT\" $TOKEN"
    echo "   3. Or try: API_HOST=http://api:5000 $0 \"$PROMPT\" $TOKEN (if using Docker Compose)"
    exit 1
fi

if ! echo "$RESPONSE" | jq -e '.' &>/dev/null; then
    echo "❌ Error: Invalid JSON response from API."
    echo "Raw response: $RESPONSE"
    exit 1
fi

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
        
        # Write content to file properly, handling special characters
        printf "%s" "$FILE_CONTENT" > "$FULL_PATH"
        
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
            if command -v find &> /dev/null; then
                JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -n 1)
            else
                # Fallback for Windows
                JAR_FILE=$(dir /s /b target\*.jar | findstr /v "original" | head -n 1)
            fi
            
            if [ -n "$JAR_FILE" ]; then
                echo "🎮 Plugin JAR file created: $JAR_FILE"
                echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
            else
                echo "⚠️ Plugin JAR file not found in target directory."
            fi
        else
            echo "----------------------------------------"
            echo "❌ Maven build failed. Attempting to fix issues with AI..."
            echo "----------------------------------------"
            
            # Initialize attempt counter
            AI_FIX_ATTEMPTS=0
            MAX_AI_FIX_ATTEMPTS=50
            BUILD_SUCCESS=false
            
            # Start AI fix loop
            while [ $AI_FIX_ATTEMPTS -lt $MAX_AI_FIX_ATTEMPTS ] && [ "$BUILD_SUCCESS" = false ]; do
                AI_FIX_ATTEMPTS=$((AI_FIX_ATTEMPTS + 1))
                echo "----------------------------------------"
                echo "🔄 AI Fix Attempt #$AI_FIX_ATTEMPTS of $MAX_AI_FIX_ATTEMPTS"
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
                
                # Create a cross-platform find command
                if command -v find &> /dev/null; then
                    find_command="find . -type f -name \"*.java\" -o -name \"pom.xml\" -o -name \"plugin.yml\" -o -name \"config.yml\""
                else
                    # Fallback for Windows without proper find command
                    find_command="dir /s /b *.java *.xml *.yml | findstr /v /i target"
                fi
                
                for FILE_PATH in $(eval $find_command); do
                    # Skip target directory files
                    if [[ "$FILE_PATH" == *"target/"* ]]; then
                        continue
                    fi
                    
                    # Get relative path to the output directory
                    if command -v realpath &> /dev/null; then
                        REL_PATH=$(realpath --relative-to="." "$FILE_PATH")
                    else
                        # Simple basename for Windows
                        REL_PATH="$FILE_PATH"
                    fi
                    
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
                
                echo "🔄 Sending build errors to API for fixing (this may take a few minutes)..."
                
                # Make API request to fix issues
                FIX_RESPONSE=$(curl -s --connect-timeout 30 --max-time 600 -X POST "$API_URL_FIX" \
                    -H "Content-Type: application/json" \
                    -H "Authorization: Bearer $TOKEN" \
                    -d @"$TEMP_JSON_FILE")
                
                # Validate fix API response
                if [ -z "$FIX_RESPONSE" ]; then
                    echo "❌ Error: Empty response from fix API. Check your network connection."
                    break
                fi
                
                if ! echo "$FIX_RESPONSE" | jq -e '.' &>/dev/null; then
                    echo "❌ Error: Invalid JSON response from fix API."
                    echo "Raw response: $FIX_RESPONSE"
                    break
                fi
                
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
                        printf "%s" "$FILE_CONTENT" > "$FILE_PATH"
                        
                        echo "🔧 Updated: $FILE_PATH"
                    done
                    
                    echo "----------------------------------------"
                    echo "🔄 Retrying build with fixed files..."
                    echo "----------------------------------------"
                    
                    # Try to build again with the fixed files
                    if mvn clean package; then
                        echo "----------------------------------------"
                        echo "✅ Build successful after $AI_FIX_ATTEMPTS AI fix attempts!"
                        echo "----------------------------------------"
                        
                        # Find the generated JAR file
                        if command -v find &> /dev/null; then
                            JAR_FILE=$(find target -name "*.jar" | grep -v "original" | head -n 1)
                        else
                            # Fallback for Windows
                            JAR_FILE=$(dir /s /b target\*.jar | findstr /v "original" | head -n 1)
                        fi
                        
                        if [ -n "$JAR_FILE" ]; then
                            echo "🎮 Plugin JAR file created: $JAR_FILE"
                            echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
                        else
                            echo "⚠️ Plugin JAR file not found in target directory."
                        fi
                        
                        BUILD_SUCCESS=true
                        break
                    else
                        echo "❌ Build still failing after fix attempt #$AI_FIX_ATTEMPTS"
                        if [ $AI_FIX_ATTEMPTS -ge $MAX_AI_FIX_ATTEMPTS ]; then
                            echo "Maximum fix attempts reached."
                        else
                            echo "Continuing with next fix attempt..."
                        fi
                    fi
                else
                    # Display error message if the fix API failed
                    ERROR_MSG=$(echo "$FIX_RESPONSE" | jq -r '.message // "Unknown error"')
                    echo "❌ Error from fix API: $ERROR_MSG"
                    echo "Continuing with next fix attempt..."
                fi
                
                # Clean up temp file for this attempt
                rm -f "$TEMP_JSON_FILE"
            done
            
            # If all AI fix attempts failed, try manual approach
            if [ "$BUILD_SUCCESS" = false ]; then
                echo "----------------------------------------"
                echo "❌ AI-based fixes unsuccessful after $MAX_AI_FIX_ATTEMPTS attempts."
                echo "🔧 Attempting manual fixes..."
                echo "----------------------------------------"
                
                # Try with skip shade option as a fallback
                echo "Attempting build with -Dmaven.shade.skip=true..."
                if mvn clean package -Dmaven.shade.skip=true; then
                    echo "⚠️ Basic build succeeded without shading."
                    
                    if command -v find &> /dev/null; then
                        JAR_FILE=$(find target -name "*.jar" | head -n 1)
                    else
                        # Windows fallback
                        JAR_FILE=$(dir /s /b target\*.jar | head -n 1)
                    fi
                    
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