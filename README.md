# Flask Annotations YOLO

A Flask application for annotating images for YOLO object detection.

## Features

- Project management for organizing annotation tasks
- Image upload and management
- Annotation interface for drawing bounding boxes
- Export annotations in YOLO format
- Real-time updates using SocketIO
- Background processing using Celery and Redis

## Docker Integration Tests

This project now includes Docker integration tests to verify the functionality of the application in a Docker environment. The tests cover:

1. **Flask, Celery, and Redis Integration**
   - Redis connection
   - Celery task execution
   - SocketIO initialization
   - Integration between all components

2. **Project Creation**
   - Creating a new project
   - Retrieving the list of projects
   - Retrieving a specific project
   - Updating a project
   - Deleting a project

3. **Image Upload**
   - Uploading an image to a project
   - Retrieving the list of images for a project
   - Retrieving a specific image from a project
   - Deleting an image from a project
   - Uploading multiple images to a project

## Running the Tests

To run the tests in a Docker environment, use the following command:

```bash
docker-compose -f docker-compose.test.yml up --build
```

For more detailed information about the tests, see the [tests/README.md](tests/README.md) file.

## Running the Application

To run the application in a Docker environment, use the following command:

```bash
docker-compose up --build
```

This will start the following services:

- **web**: The Flask web application
- **redis**: The Redis server for message queuing and caching
- **celery_worker**: The Celery worker for background processing

## Environment Variables

The application uses the following environment variables:

- `SECRET_KEY`: Secret key for Flask sessions
- `PROJECTS_FOLDER`: Path to the projects folder
- `CELERY_BROKER_URL`: URL for the Celery broker (Redis)
- `CELERY_RESULT_BACKEND`: URL for the Celery result backend (Redis)
- `REDIS_HOST`: Hostname for the Redis server
- `REDIS_PORT`: Port for the Redis server
- `REDIS_RESULT_DB`: Redis database number for Celery results
- `SOCKETIO_CORS_ALLOWED_ORIGINS`: CORS allowed origins for SocketIO

These can be set in a `.env` file in the project root.

## Project Structure

- `app.py`: Main Flask application
- `docker-compose.yml`: Docker Compose configuration for running the application
- `docker-compose.test.yml`: Docker Compose configuration for running the tests
- `Dockerfile`: Docker configuration for building the application image
- `requirements.txt`: Python dependencies
- `static/`: Static files (CSS, JavaScript)
- `templates/`: HTML templates
- `projects/`: Project data (created at runtime)
- `tests/`: Integration tests