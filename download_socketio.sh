#!/bin/bash
set -e

# Create directory structure
mkdir -p node_modules/socket.io-client/dist

# Download Socket.IO client library
curl -s https://cdn.socket.io/4.5.4/socket.io.min.js -o node_modules/socket.io-client/dist/socket.io.js

echo "Socket.IO client library downloaded successfully"