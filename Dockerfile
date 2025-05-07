FROM node:18-bullseye

# Set working directory
WORKDIR /app

# Install system dependencies including Java and Maven
RUN apt-get update && apt-get install -y \
    openjdk-11-jdk \
    maven \
    curl \
    jq \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set Maven options for better performance
ENV MAVEN_OPTS="-Xmx1024m -XX:MaxMetaspaceSize=512m"

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the application code
COPY . .

# Make the bash script executable
RUN chmod +x bash.sh

# Build TypeScript code
RUN npm run build

# Create generated-plugins directory with proper permissions
RUN mkdir -p generated-plugins && chmod 777 generated-plugins

# Expose the API port
EXPOSE 5000

# Command to run the application
CMD ["node", "dist/app.js"]