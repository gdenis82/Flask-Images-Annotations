FROM python:3.10-slim-bullseye


WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    iputils-ping \
    dnsutils \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt


# Install gunicorn
RUN pip install --no-cache-dir gunicorn

# Copy application code
COPY . .

# Create non-root user
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g 1000 -s /bin/bash -m appuser

# Create necessary directories with appropriate permissions
RUN mkdir -p projects/temp && chmod -R 777 projects && \
    chown -R appuser:appuser /app

# Download Socket.IO client library
RUN chmod +x download_socketio.sh && ./download_socketio.sh

# Set environment variables
ENV FLASK_APP=app.py
ENV PYTHONUNBUFFERED=1

# Expose port
EXPOSE 5000

# Command to run the application with gunicorn
# Use a formula based on CPU cores: (2 * CPU cores) + 1
# For most environments, 4 workers is a good starting point
CMD ["gunicorn", "--worker-class", "eventlet", "--workers", "1", "--bind", "0.0.0.0:5000", "--log-level", "info", "app:app"]
