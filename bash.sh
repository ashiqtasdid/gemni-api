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
REQUIRED_TOOLS=("mvn" "jq" "curl")
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

# Handle command line arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <plugin_directory> <bearer_token> [api_host]"
    echo "Example: $0 /path/to/plugin-directory my-token http://localhost:5000"
    exit 1
fi

# Parse arguments
PLUGIN_DIR="$1"
TOKEN="$2"
API_HOST="${3:-http://localhost:5000}"
API_URL_FIX="${API_HOST}/api/fix"

# Check if directory exists
if [ ! -d "$PLUGIN_DIR" ]; then
    echo "❌ Error: Plugin directory does not exist: $PLUGIN_DIR"
    exit 1
fi

# Check if pom.xml exists
if [ ! -f "$PLUGIN_DIR/pom.xml" ]; then
    echo "❌ Error: No pom.xml found in $PLUGIN_DIR"
    exit 1
fi

echo "----------------------------------------"
echo "🔨 Building plugin with Maven..."
echo "----------------------------------------"

# Save current directory to return later
CURRENT_DIR=$(pwd)

# Change to the plugin directory
cd "$PLUGIN_DIR"

# Cross-platform command helper
find_command() {
    if command -v "$1" &> /dev/null; then
        eval "$2"
    else
        eval "$3"
    fi
}

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
        echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\"}" > "$PLUGIN_DIR/build_result.json"
        exit 0
    else
        echo "⚠️ Plugin JAR file not found in target directory."
        echo "{\"success\":false,\"error\":\"JAR file not found\"}" > "$PLUGIN_DIR/build_result.json"
        exit 1
    fi
else
    echo "----------------------------------------"
    echo "❌ Maven build failed. Attempting to fix issues with AI..."
    echo "----------------------------------------"

    # Initialize attempt counter
    AI_FIX_ATTEMPTS=0
    MAX_AI_FIX_ATTEMPTS=5 # Reduced from 50 to 5 for efficiency
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
        if ! echo "$FIX_RESPONSE" | jq -e '.status == "success"' > /dev/null; then
            ERROR_MSG=$(echo "$FIX_RESPONSE" | jq -r '.message // "Unknown error"')
            echo "❌ Error from fix API: $ERROR_MSG"
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
                echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"fixes\":$AI_FIX_ATTEMPTS}" > "$PLUGIN_DIR/build_result.json"
                BUILD_SUCCESS=true
                break
            else
                echo "⚠️ Plugin JAR file not found in target directory."
            fi
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
                echo "{\"success\":true,\"jarPath\":\"$JAR_FILE\",\"noShade\":true}" > "$PLUGIN_DIR/build_result.json"
            else
                echo "{\"success\":false,\"error\":\"No JAR file created even with shade skipping\"}" > "$PLUGIN_DIR/build_result.json"
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
            echo "{\"success\":false,\"error\":\"All build attempts failed\",\"buildErrors\":$(jq -Rs . <<< "$BUILD_ERRORS")}" > "$PLUGIN_DIR/build_result.json"
            exit 1
        fi
    fi
fi

# Return to original directory
cd "$CURRENT_DIR"

echo "----------------------------------------"
echo "✨ Process completed"
echo "----------------------------------------"