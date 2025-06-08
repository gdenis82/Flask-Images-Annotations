# Docker Integration Tests

This directory contains tests for verifying the integration between Flask, Celery, Redis, and SocketIO in a Docker environment.

## Test Files

- `test_flask_celery_redis.py`: Tests the connection between Flask, Celery, and Redis
- `test_project_creation.py`: Tests the project creation functionality
- `test_image_upload.py`: Tests the image upload functionality

## Running the Tests

### Using Docker Compose

To run the tests in a Docker environment, use the following command from the project root:

```bash
docker-compose -f docker-compose.test.yml up --build
```

This will:
1. Build the Docker images if needed
2. Start the Redis service
3. Start the Celery worker
4. Run the tests

### Running Individual Tests

If you want to run a specific test file, you can use the following command:

```bash
docker-compose -f docker-compose.test.yml run test python -m unittest tests/test_flask_celery_redis.py
```

Replace `tests/test_flask_celery_redis.py` with the path to the test file you want to run.

### Running Tests Locally

If you want to run the tests locally (outside of Docker), you need to:

1. Make sure Redis is running
2. Set the appropriate environment variables
3. Run the tests using the unittest module

```bash
# Set environment variables
export CELERY_BROKER_URL=redis://localhost:6379/0
export CELERY_RESULT_BACKEND=redis://localhost:6379/0
export REDIS_HOST=localhost
export SOCKETIO_MESSAGE_QUEUE=redis://localhost:6379/0
export SOCKETIO_CORS_ALLOWED_ORIGINS=*

# Run the tests
python -m unittest discover -s tests
```

## Test Coverage

The tests cover the following functionality:

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

## Troubleshooting

If you encounter issues running the tests, check the following:

1. Make sure Redis is running and accessible
2. Check that the environment variables are set correctly
3. Verify that the Celery worker is running
4. Check the Docker logs for any error messages

```bash
docker-compose -f docker-compose.test.yml logs
```