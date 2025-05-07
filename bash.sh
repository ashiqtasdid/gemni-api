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

# Check for required dependencies
REQUIRED_TOOLS=("curl" "jq" "mvn")
MISSING_TOOLS=()

for tool in "${REQUIRED_TOOLS[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
        MISSING_TOOLS+=("$tool")
    fi
done

if [ ${#MISSING_TOOLS[@]} -ne 0 ]; then
    echo "❌ Error: The following required tools are missing:"
    for tool in "${MISSING_TOOLS[@]}"; do
        echo "  - $tool"
    done
    echo "Please install them before continuing."
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
API_HOST="${API_HOST:-http://host.docker.internal:5000}"
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
find_command() {
    if command -v "$1" &> /dev/null; then
        eval "$2"
    else
        eval "$3"
    fi
}

find_command "realpath" \
    "BASE_OUTPUT_DIR=\"\$(realpath -m \"$BASE_OUTPUT_DIR\")\"" \
    "BASE_OUTPUT_DIR=\"\$(cd \"$BASE_OUTPUT_DIR\" 2>/dev/null || mkdir -p \"$BASE_OUTPUT_DIR\" && cd \"$BASE_OUTPUT_DIR\" && pwd)\""

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

# Validate API response function
validate_response() {
    local response="$1"
    local purpose="$2"
    
    # Check for empty response
    if [ -z "$response" ]; then
        echo "❌ Error: Empty response from $purpose API. Check your network connection."
        if [ "$purpose" = "plugin generation" ]; then
            echo "ℹ️ If this keeps failing, try one of these options:"
            echo "   1. Edit $CONFIG_FILE and set API_HOST=http://localhost:5000"
            echo "   2. Or try: API_HOST=http://host.docker.internal:5000 $0 \"$PROMPT\" $TOKEN"
            echo "   3. Or try: API_HOST=http://api:5000 $0 \"$PROMPT\" $TOKEN (if using Docker Compose)"
        fi
        return 1
    fi
    
    # Check for valid JSON
    if ! echo "$response" | jq -e '.' &>/dev/null; then
        echo "❌ Error: Invalid JSON response from $purpose API."
        echo "Raw response: $response"
        return 1
    fi
    
    # Check for success status
    if ! echo "$response" | jq -e '.status == "success"' > /dev/null; then
        ERROR_MSG=$(echo "$response" | jq -r '.message // "Unknown error"')
        echo "❌ Error from $purpose API: $ERROR_MSG"
        return 1
    fi
    
    return 0
}

# Validate and process the response
if ! validate_response "$RESPONSE" "plugin generation"; then
    echo "Full response: $RESPONSE"
    exit 1
fi

echo "✅ Plugin generated successfully!"

# Extract the data field containing files and create directories more efficiently
FILES=$(echo "$RESPONSE" | jq '.data')
DIRS_CREATED=()

for FILE_PATH in $(echo "$FILES" | jq -r 'keys[]'); do
    # Extract directory path
    DIR_PATH=$(dirname "$OUTPUT_DIR/$FILE_PATH")
    
    # Create directory only if not already created
    if [[ ! " ${DIRS_CREATED[@]} " =~ " ${DIR_PATH} " ]]; then
        mkdir -p "$DIR_PATH"
        DIRS_CREATED+=("$DIR_PATH")
    fi
    
    # Write content directly to file
    echo "$FILES" | jq -r --arg path "$FILE_PATH" '.[$path]' > "$OUTPUT_DIR/$FILE_PATH"
    echo "📄 Created: $FILE_PATH"
done

echo "🎉 Plugin files have been successfully created in $OUTPUT_DIR"

# Validate main class consistency
validate_main_class() {
    local plugin_yml="$OUTPUT_DIR/src/main/resources/plugin.yml"
    if [ -f "$plugin_yml" ]; then
        local main_class=$(grep "main:" "$plugin_yml" | cut -d ":" -f2 | tr -d ' ')
        
        # Convert package name to path format
        local package_path=$(echo "$main_class" | sed 's/\./\//g')
        local class_name=$(echo "$main_class" | awk -F. '{print $NF}')
        local expected_file="$OUTPUT_DIR/src/main/java/${package_path}.java"
        
        # Check if the Java file for the main class exists
        if [ ! -f "$expected_file" ]; then
            echo "⚠️ Warning: Main class $main_class specified in plugin.yml doesn't match any Java file."
            
            # Find the actual JavaPlugin implementation
            find_command "find" \
                "ACTUAL_FILES=\$(find \"$OUTPUT_DIR/src/main/java\" -name \"*.java\" -type f)" \
                "ACTUAL_FILES=\$(dir /s /b \"$OUTPUT_DIR\\src\\main\\java\\*.java\" | tr '\\\\' '/')"
                
            for file in $ACTUAL_FILES; do
                if grep -q "public class .* extends JavaPlugin" "$file"; then
                    # Extract package and class name
                    local actual_package=$(grep -o "package .*;" "$file" | sed 's/package //' | sed 's/;//')
                    local actual_class_name=$(grep -o "public class .* extends JavaPlugin" "$file" | awk '{print $3}')
                    local actual_full_class="$actual_package.$actual_class_name"
                    
                    echo "🔧 Fixing: Updating main class in plugin.yml to $actual_full_class"
                    sed -i "s/main: .*/main: $actual_full_class/" "$plugin_yml"
                    break
                fi
            done
        fi
    fi
}

# Check if main class in plugin.yml matches Java file
validate_main_class

# Check if pom.xml exists and build with Maven
if [ -f "$OUTPUT_DIR/pom.xml" ]; then
    echo "----------------------------------------"
    echo "🔨 Building plugin with Maven..."
    echo "----------------------------------------"
    
    # Save current directory to return later
    CURRENT_DIR=$(pwd)
    
    # Change to the plugin directory
    cd "$OUTPUT_DIR"
    
    # More efficient Maven build process
    build_plugin() {
        echo "🧹 Cleaning previous build artifacts..."
        rm -rf target/
        
        echo "🏗️ Running Maven build..."
        if mvn clean package -B; then
            return 0
        else
            return 1
        fi
    }
    
    # Find the JAR file more efficiently
    find_jar_file() {
        find_command "find" \
            "JAR_FILE=\$(find target -name \"*.jar\" | grep -v \"original\" | head -n 1)" \
            "JAR_FILE=\$(dir /s /b target\\*.jar | findstr /v \"original\" | head -n 1 | tr '\\\\' '/')"
        echo "$JAR_FILE"
    }
    
    # Collect file contents for AI fix more efficiently
    collect_file_contents() {
        local first=true
        local file_data=""
        
        find_command "find" \
            "FILE_LIST=\$(find . -type f \\( -name \"*.java\" -o -name \"pom.xml\" -o -name \"plugin.yml\" -o -name \"config.yml\" \\) 2>/dev/null)" \
            "FILE_LIST=\$(dir /s /b *.java *.xml *.yml | findstr /v /i target)"
        
        for file in $FILE_LIST; do
            # Skip target directory files
            [[ "$file" == *"target/"* ]] && continue
            
            if [ "$first" = true ]; then
                first=false
            else
                file_data+=","
            fi
            
            # Get relative path
            find_command "realpath" \
                "REL_PATH=\$(realpath --relative-to=\".\" \"$file\")" \
                "REL_PATH=\"$file\""
            
            file_data+="\"$REL_PATH\": $(jq -Rs . < "$file")"
        done
        
        echo "$file_data"
    }
    
    # Try to build the plugin
    if build_plugin; then
        echo "----------------------------------------"
        echo "✅ Maven build successful!"
        echo "----------------------------------------"
        
        # Find the generated JAR file
        JAR_FILE=$(find_jar_file)
        
        if [ -n "$JAR_FILE" ]; then
            echo "🎮 Plugin JAR file created: $JAR_FILE"
            echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
            # Add standardized output for the server to parse
            echo "PLUGIN_JAR_PATH:$JAR_FILE"
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
            collect_file_contents >> "$TEMP_JSON_FILE"
            echo "  }" >> "$TEMP_JSON_FILE"
            echo "}" >> "$TEMP_JSON_FILE"
            
            echo "🔄 Sending build errors to API for fixing (this may take a few minutes)..."
            
            # Make API request to fix issues
            FIX_RESPONSE=$(curl -s --connect-timeout 30 --max-time 600 -X POST "$API_URL_FIX" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $TOKEN" \
                -d @"$TEMP_JSON_FILE")
            
            # Validate fix API response
            if ! validate_response "$FIX_RESPONSE" "fix"; then
                echo "Continuing with next fix attempt..."
                rm -f "$TEMP_JSON_FILE"
                continue
            fi
            
            echo "✅ Received fixes from API!"
            
            # Extract the fixed files
            FIXED_FILES=$(echo "$FIX_RESPONSE" | jq '.data')
            
            # Process each fixed file
            for FILE_PATH in $(echo "$FIXED_FILES" | jq -r 'keys[]'); do
                # Write content directly to file
                echo "$FIXED_FILES" | jq -r --arg path "$FILE_PATH" '.[$path]' > "$FILE_PATH"
                echo "🔧 Updated: $FILE_PATH"
            done
            
            echo "----------------------------------------"
            echo "🔄 Retrying build with fixed files..."
            echo "----------------------------------------"
            
            # Try to build again with the fixed files
            if build_plugin; then
                echo "----------------------------------------"
                echo "✅ Build successful after $AI_FIX_ATTEMPTS AI fix attempts!"
                echo "----------------------------------------"
                
                # Find the generated JAR file
                JAR_FILE=$(find_jar_file)
                
                if [ -n "$JAR_FILE" ]; then
                    echo "🎮 Plugin JAR file created: $JAR_FILE"
                    echo "To use the plugin, copy this JAR file to your Minecraft server's plugins folder."
                    # Add standardized output for the server to parse
                    echo "PLUGIN_JAR_PATH:$JAR_FILE"
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
                
                find_command "find" \
                    "JAR_FILE=\$(find target -name \"*.jar\" | head -n 1)" \
                    "JAR_FILE=\$(dir /s /b target\\*.jar | head -n 1 | tr '\\\\' '/')"
                
                if [ -n "$JAR_FILE" ]; then
                    echo "🎮 Plugin JAR file created (without shading): $JAR_FILE"
                    echo "Note: This JAR may not include all dependencies."
                    # Add standardized output for the server to parse
                    echo "PLUGIN_JAR_PATH:$JAR_FILE"
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

echo "----------------------------------------"
echo "✨ Process completed"
echo "----------------------------------------"