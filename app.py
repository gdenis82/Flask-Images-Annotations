import os
import json
import uuid
import sys
import io
import base64
import logging
import redis
import threading
import time
import socket
from celery import Celery
from flask_socketio import SocketIO
from dotenv import load_dotenv
from os.path import join, dirname
from datetime import datetime
from PIL import Image
from flask import Flask, render_template, request, jsonify, session, send_from_directory

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
dotenv_path = join(dirname(__file__), '.env')  # Address of your .env file
load_dotenv(dotenv_path)

PROJECTS_FOLDER = os.getenv('PROJECTS_FOLDER', 'projects')
# Ensure projects directory exists
if not os.path.exists(PROJECTS_FOLDER):
    os.makedirs(PROJECTS_FOLDER)

# Initialize Redis for storing upload status
# Check if we're running in local mode or Docker mode
flask_run_mode = os.getenv('FLASK_RUN_MODE', 'docker')
# If running locally, use localhost for Redis, otherwise use the Docker service name
default_redis_host = 'localhost' if flask_run_mode.lower() == 'local' else 'redis'
redis_host = os.getenv('REDIS_HOST', default_redis_host)
redis_port = int(os.getenv('REDIS_PORT', 6379))
redis_db = int(os.getenv('REDIS_RESULT_DB', 0))

# Flask app setup
app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', os.urandom(24))
app.config['PROJECTS_FOLDER'] = PROJECTS_FOLDER

# Celery configuration
app.config.update(
    broker_url=os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0'),
    result_backend=os.getenv('CELERY_RESULT_BACKEND', 'redis://localhost:6379/0'),
    broker_connection_retry_on_startup=os.getenv('BROKER_CONNECTION_RETRY_ON_STARTUP', 'true').lower() == 'true'
)

# Initialize Celery
def make_celery(app):
    celery = Celery(
        app.import_name,
        backend=app.config['result_backend'],
        broker=app.config['broker_url']
    )
    celery.conf.update(app.config)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return self.run(*args, **kwargs)

    celery.Task = ContextTask
    return celery

celery = make_celery(app)


# Initialize SocketIO and Redis
# Simple Redis client for fallback when Redis is not available
class SimpleRedisClient:
    def __init__(self):
        self.data = {}
        logger.warning("Using in-memory store as Redis is not available")

    def hset(self, key, field, value):
        if key not in self.data:
            self.data[key] = {}
        self.data[key][field] = value
        return 1

    def hget(self, key, field):
        if key in self.data and field in self.data[key]:
            value = self.data[key][field]
            if isinstance(value, str):
                return value.encode('utf-8')
            return value
        return None

    def exists(self, key):
        return key in self.data

    def publish(self, channel, message):
        logger.info(f"Would publish to {channel}: {message}")
        # In the simple version, we directly emit the event to Socket.IO
        try:
            data = json.loads(message)
            event = data.get('event')
            event_data = data.get('data')
            if event and event_data:
                socketio.emit(event, event_data)
        except Exception as e:
            logger.error(f"Error publishing message: {e}")
        return 0

    def ping(self):
        return True

    def pubsub(self):
        return self  # Return self as a dummy pubsub client

    def subscribe(self, channel):
        logger.info(f"Would subscribe to {channel}")
        return True

    def listen(self):
        # This is a dummy method that never yields anything
        while True:
            time.sleep(3600)  # Sleep for an hour

# Function to resolve hostname to IP address with retries
def resolve_hostname(hostname, max_retries=8, initial_delay=2):
    """Resolve hostname to IP address with retries and exponential backoff"""
    # If hostname is already an IP address, return it
    if hostname.replace('.', '').isdigit():
        logger.info(f"Hostname {hostname} is already an IP address")
        return hostname

    # Try standard DNS resolution with a custom resolver and timeout
    for attempt in range(1, max_retries + 1):
        try:
            logger.info(f"Resolving hostname {hostname} (attempt {attempt}/{max_retries})")

            # Set a default socket timeout for DNS resolution
            old_timeout = socket.getdefaulttimeout()
            socket.setdefaulttimeout(5)  # 5 second timeout for DNS resolution

            try:
                # Use a custom resolver with a longer timeout
                resolver = socket.getaddrinfo(hostname, None)
                for res in resolver:
                    family, socktype, proto, canonname, sockaddr = res
                    if family == socket.AF_INET:  # IPv4
                        ip_address = sockaddr[0]
                        logger.info(f"Successfully resolved {hostname} to {ip_address}")
                        return ip_address

                # Fallback to standard gethostbyname if getaddrinfo doesn't return IPv4
                ip_address = socket.gethostbyname(hostname)
                logger.info(f"Successfully resolved {hostname} to {ip_address}")
                return ip_address
            finally:
                # Restore the default timeout
                socket.setdefaulttimeout(old_timeout)

        except (socket.gaierror, socket.timeout) as e:
            logger.warning(f"Hostname resolution attempt {attempt} failed: {e}")
            if attempt < max_retries:
                # Calculate delay with exponential backoff (2s, 4s, 8s, 16s, 32s)
                delay = initial_delay * (2 ** (attempt - 1))
                logger.info(f"Retrying in {delay} seconds...")
                time.sleep(delay)
            else:
                logger.error(f"Failed to resolve hostname {hostname} after {max_retries} attempts")

                # Try common Docker network IP addresses as fallback
                if hostname == 'redis':
                    logger.info("Trying common Docker network IP addresses for Redis")
                    # Common Docker network IP addresses
                    fallback_ips = [
                        # Direct container name (Docker DNS should resolve this)
                        'redis',  # Try the container name directly with a longer timeout
                        # Common Docker network IP addresses
                        '172.17.0.2',  # Default Docker bridge network first container
                        '172.18.0.2',  # Custom bridge network first container
                        '172.19.0.2',  # Another possible custom bridge network
                        '172.20.0.2',  # Another possible custom bridge network
                        '172.21.0.2',  # Another possible custom bridge network
                        '172.22.0.2',  # Another possible custom bridge network
                        '172.23.0.2',  # Another possible custom bridge network
                        '172.24.0.2',  # Another possible custom bridge network
                        '172.25.0.2',  # Another possible custom bridge network
                        '10.0.0.2',    # Possible custom network
                        '10.0.1.2',    # Possible custom network
                        '10.0.2.2',    # Possible custom network
                        '10.0.3.2',    # Possible custom network
                        # Gateway IPs
                        '172.17.0.1',  # Default Docker bridge network gateway
                        '172.18.0.1',  # Custom bridge network gateway
                        '172.19.0.1',  # Another possible custom bridge network gateway
                        '172.20.0.1',  # Another possible custom bridge network gateway
                        '172.21.0.1',  # Another possible custom bridge network gateway
                        '172.22.0.1',  # Another possible custom bridge network gateway
                        '172.23.0.1',  # Another possible custom bridge network gateway
                        '172.24.0.1',  # Another possible custom bridge network gateway
                        '172.25.0.1',  # Another possible custom bridge network gateway
                        '10.0.0.1',    # Possible custom network gateway
                        '10.0.1.1',    # Possible custom network gateway
                        '10.0.2.1',    # Possible custom network gateway
                        '10.0.3.1',    # Possible custom network gateway
                        # Host machine (Docker host)
                        'host.docker.internal',  # Special Docker DNS name for the host machine
                        # Localhost as last resort
                        '127.0.0.1',  # Localhost
                        'localhost'   # Localhost hostname
                    ]

                    # Try to connect to each IP
                    for ip in fallback_ips:
                        logger.info(f"Trying fallback IP/hostname {ip} for Redis")
                        try:
                            # For special hostnames, try to resolve them first
                            connect_ip = ip
                            if ip in ['redis', 'host.docker.internal', 'localhost'] and not ip.replace('.', '').isdigit():
                                try:
                                    # Set a longer timeout for this resolution attempt
                                    old_timeout = socket.getdefaulttimeout()
                                    socket.setdefaulttimeout(5)  # 5 second timeout
                                    try:
                                        resolved_ip = socket.gethostbyname(ip)
                                        logger.info(f"Resolved {ip} to {resolved_ip}")
                                        connect_ip = resolved_ip
                                    finally:
                                        socket.setdefaulttimeout(old_timeout)
                                except Exception as resolve_error:
                                    logger.warning(f"Failed to resolve {ip}: {resolve_error}")
                                    # Continue with the original hostname if it's 'redis'
                                    if ip == 'redis':
                                        connect_ip = ip  # Keep using 'redis' as hostname

                            # Try to connect to Redis on this IP/hostname
                            test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                            test_socket.settimeout(3)  # Increased from 1 to 3 seconds
                            test_socket.connect((connect_ip, 6379))
                            test_socket.close()
                            logger.info(f"Successfully connected to Redis at {connect_ip}:6379")
                            return connect_ip
                        except Exception as e:
                            logger.warning(f"Failed to connect to Redis at {ip}:6379: {e}")

                    logger.error("All fallback IP addresses failed")

                return None
        except Exception as e:
            logger.error(f"Unexpected error resolving hostname {hostname}: {e}")
            return None

# Function to initialize Redis with retries and exponential backoff
def initialize_redis_with_retries(max_retries=8, initial_delay=2):
    """Initialize Redis client with retries and exponential backoff"""
    # First try to resolve the hostname to an IP address
    host_to_use = redis_host
    if redis_host != 'localhost' and not redis_host.replace('.', '').isdigit():
        # Try to resolve the hostname
        ip_address = resolve_hostname(redis_host, max_retries, initial_delay)
        if ip_address:
            host_to_use = ip_address
            logger.info(f"Using resolved IP address {ip_address} instead of hostname {redis_host}")
        else:
            logger.warning(f"Could not resolve hostname {redis_host}, using it directly")

    # Try both the resolved IP and the original hostname
    hosts_to_try = [host_to_use]
    if host_to_use != redis_host:
        hosts_to_try.append(redis_host)  # Also try the original hostname as fallback

    # Now try to connect to Redis using each host in the list
    for host_to_try in hosts_to_try:
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Connecting to Redis at {host_to_try}:{redis_port} (attempt {attempt}/{max_retries})")
                client = redis.Redis(
                    host=host_to_try,
                    port=redis_port,
                    db=redis_db,
                    socket_timeout=60,
                    socket_connect_timeout=60,
                    health_check_interval=60,
                    retry_on_timeout=True,
                    decode_responses=False
                )

                # Test connection with ping
                client.ping()
                logger.info(f"Successfully connected to Redis at {host_to_try}:{redis_port}")
                return client
            except redis.exceptions.ConnectionError as e:
                logger.warning(f"Redis connection attempt {attempt} failed for host {host_to_try}: {e}")
                if attempt < max_retries:
                    # Calculate delay with exponential backoff (2s, 4s, 8s, 16s, 32s)
                    delay = initial_delay * (2 ** (attempt - 1))
                    logger.info(f"Retrying in {delay} seconds...")
                    time.sleep(delay)
                elif host_to_try == hosts_to_try[-1]:  # If this is the last host to try
                    logger.error(f"Failed to connect to Redis after {max_retries} attempts for all hosts")
                    raise
                else:
                    logger.warning(f"Failed to connect to Redis using {host_to_try}, trying next host")
                    break  # Break out of the attempt loop and try the next host
            except Exception as e:
                logger.error(f"Unexpected error connecting to Redis using {host_to_try}: {e}")
                if host_to_try == hosts_to_try[-1]:  # If this is the last host to try
                    raise
                else:
                    logger.warning(f"Failed to connect to Redis using {host_to_try}, trying next host")
                    break  # Break out of the attempt loop and try the next host

# Initialize Redis and Socket.IO
try:
    # Log system information for debugging
    logger.info(f"System hostname: {socket.gethostname()}")
    logger.info(f"Redis configuration - Host: {redis_host}, Port: {redis_port}, DB: {redis_db}")

    # Try to ping the Redis host to check network connectivity with retries
    redis_ip = None
    dns_retries = 5  # Increased from 3 to 5
    dns_retry_delay = 3  # Increased from 2 to 3

    # First, try to connect directly to Redis using the hostname
    # This is often more reliable than DNS resolution in Docker networks
    try:
        logger.info(f"Trying to connect directly to Redis host '{redis_host}' on port 6379...")
        test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        test_socket.settimeout(5)  # 5 second timeout
        test_socket.connect((redis_host, 6379))
        test_socket.close()
        logger.info(f"Successfully connected to Redis at {redis_host}:6379")
        redis_ip = redis_host  # Use the hostname directly since it works
    except Exception as e:
        logger.warning(f"Direct connection to Redis at {redis_host}:6379 failed: {e}")
        logger.info("Falling back to DNS resolution...")

        # If direct connection fails, try DNS resolution
        for dns_attempt in range(1, dns_retries + 1):
            try:
                logger.info(f"Attempting to resolve Redis hostname '{redis_host}' using DNS (attempt {dns_attempt}/{dns_retries})...")

                # Set a timeout for DNS resolution
                old_timeout = socket.getdefaulttimeout()
                socket.setdefaulttimeout(5)  # 5 second timeout for DNS resolution

                try:
                    # Try getaddrinfo first
                    try:
                        resolver = socket.getaddrinfo(redis_host, None)
                        for res in resolver:
                            family, socktype, proto, canonname, sockaddr = res
                            if family == socket.AF_INET:  # IPv4
                                redis_ip = sockaddr[0]
                                logger.info(f"DNS resolution (getaddrinfo): {redis_host} -> {redis_ip}")
                                break
                        if redis_ip:
                            break
                    except Exception as e:
                        logger.warning(f"getaddrinfo failed for '{redis_host}': {e}")

                    # Fallback to gethostbyname
                    if not redis_ip:
                        redis_ip = socket.gethostbyname(redis_host)
                        logger.info(f"DNS resolution (gethostbyname): {redis_host} -> {redis_ip}")
                        break
                finally:
                    # Restore the default timeout
                    socket.setdefaulttimeout(old_timeout)

            except Exception as e:
                logger.warning(f"DNS resolution attempt {dns_attempt} failed for '{redis_host}': {e}")
                if dns_attempt < dns_retries:
                    logger.info(f"Retrying DNS resolution in {dns_retry_delay} seconds...")
                    time.sleep(dns_retry_delay)
                    dns_retry_delay *= 2  # Exponential backoff
                else:
                    logger.warning(f"All DNS resolution attempts failed for '{redis_host}'")

                    # Try to ping the Redis host directly one more time
                    try:
                        logger.info(f"Trying to connect directly to Redis host '{redis_host}' on port 6379 (final attempt)...")
                        test_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        test_socket.settimeout(5)  # 5 second timeout
                        test_socket.connect((redis_host, 6379))
                        test_socket.close()
                        logger.info(f"Successfully connected to Redis at {redis_host}:6379")
                        redis_ip = redis_host  # Use the hostname directly
                    except Exception as e:
                        logger.warning(f"Failed to connect directly to Redis at {redis_host}:6379: {e}")

    # Add a short delay to ensure Redis container is fully started and DNS is ready
    # This delay is reduced because Docker Compose health checks should ensure Redis is ready
    # But we still need a small delay to ensure DNS is properly propagated
    logger.info("Waiting 2 seconds before connecting to Redis...")
    time.sleep(2)

    # Try to connect to Redis with retries (increased retries and delay)
    # If we already have a successful direct connection, use the hostname directly
    if redis_ip:
        try:
            logger.info(f"Using direct connection to Redis at {redis_ip}:6379")
            redis_client = redis.Redis(
                host=redis_ip,
                port=redis_port,
                db=redis_db,
                socket_timeout=60,
                socket_connect_timeout=60,
                health_check_interval=60,
                retry_on_timeout=True,
                decode_responses=False
            )
            # Test connection with ping
            redis_client.ping()
            logger.info(f"Successfully connected to Redis at {redis_ip}:{redis_port}")
        except Exception as e:
            logger.warning(f"Direct connection to Redis failed: {e}")
            # Fall back to initialize_redis_with_retries
            redis_client = initialize_redis_with_retries(max_retries=8, initial_delay=3)
    else:
        # No direct connection was successful, use initialize_redis_with_retries
        redis_client = initialize_redis_with_retries(max_retries=8, initial_delay=3)

    # Initialize Socket.IO with Redis using the same host as the Redis client
    # Extract the host from the Redis client connection
    redis_connection_host = getattr(redis_client, 'connection_pool', None)
    if redis_connection_host:
        redis_connection_host = getattr(redis_connection_host, 'connection_kwargs', {}).get('host', redis_host)
    else:
        redis_connection_host = redis_host

    # Try to initialize Socket.IO with Redis message queue with retries (increased retries and delay)
    socketio = None
    max_socketio_retries = 5  # Increased from 3 to 5
    for socketio_attempt in range(1, max_socketio_retries + 1):
        try:
            logger.info(f"Initializing Socket.IO with Redis message queue (attempt {socketio_attempt}/{max_socketio_retries})")
            message_queue = f"redis://{redis_connection_host}:{redis_port}/0"
            socketio = SocketIO(app, message_queue=message_queue, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
            logger.info(f"Successfully initialized Socket.IO with Redis message queue at {redis_connection_host}:{redis_port}")
            break
        except Exception as e:
            logger.warning(f"Socket.IO initialization attempt {socketio_attempt} failed: {e}")
            if socketio_attempt < max_socketio_retries:
                # Wait before retrying with longer delays
                retry_delay = 3 * socketio_attempt  # 3, 6, 9, 12, 15 seconds (increased from 2, 4, 6)
                logger.info(f"Retrying Socket.IO initialization in {retry_delay} seconds...")
                time.sleep(retry_delay)
            else:
                logger.error(f"Failed to initialize Socket.IO with Redis message queue after {max_socketio_retries} attempts")
                # Will fall back to non-Redis Socket.IO in the except block
                raise

    # Set up Redis pubsub for Socket.IO events with retries (increased retries and delay)
    # Only set up pubsub if socketio is initialized
    if socketio:
        max_pubsub_retries = 5  # Increased from 3 to 5
        for pubsub_attempt in range(1, max_pubsub_retries + 1):
            try:
                logger.info(f"Setting up Redis pubsub (attempt {pubsub_attempt}/{max_pubsub_retries})")
                pubsub_client = redis_client.pubsub()
                pubsub_client.subscribe('socketio_events')

                # Start a background thread to listen for messages
                def handle_pubsub_messages(pubsub):
                    try:
                        logger.info("Starting pubsub message listener thread")
                        for message in pubsub.listen():
                            try:
                                if message['type'] == 'message':
                                    data = json.loads(message['data'].decode('utf-8'))
                                    event = data.get('event')
                                    event_data = data.get('data')

                                    if event and event_data and socketio:
                                        # Emit the event to all connected clients
                                        socketio.emit(event, event_data)
                                        logger.info(f"Emitted {event} event from Redis pubsub")
                                    elif event and event_data:
                                        logger.warning(f"Cannot emit {event} event: socketio is not initialized")
                            except Exception as e:
                                logger.error(f"Error processing pubsub message: {e}")
                    except redis.exceptions.ConnectionError as e:
                        logger.error(f"Redis pubsub connection error: {e}")
                        # Try to reconnect with increased delay
                        time.sleep(10)  # Increased from 5 to 10 seconds
                        try:
                            pubsub = redis_client.pubsub()
                            pubsub.subscribe('socketio_events')
                            logger.info("Reconnected to Redis pubsub")
                        except Exception as reconnect_error:
                            logger.error(f"Failed to reconnect to Redis pubsub: {reconnect_error}")
                    except Exception as e:
                        logger.error(f"Error in pubsub listener thread: {e}")

                # Start the pubsub listener thread
                pubsub_thread = threading.Thread(target=lambda: handle_pubsub_messages(pubsub_client), daemon=True)
                pubsub_thread.start()
                logger.info("Started Redis pubsub listener thread")
                break
            except Exception as e:
                logger.warning(f"Redis pubsub setup attempt {pubsub_attempt} failed: {e}")
                if pubsub_attempt < max_pubsub_retries:
                    # Increased delay between retries
                    retry_delay = 3 * pubsub_attempt  # 3, 6, 9, 12, 15 seconds (increased from fixed 2 seconds)
                    logger.info(f"Retrying Redis pubsub setup in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                else:
                    logger.error(f"Failed to set up Redis pubsub after {max_pubsub_retries} attempts")
                    raise
    else:
        logger.warning("Skipping Redis pubsub setup because Socket.IO is not initialized")

except Exception as e:
    logger.error(f"Failed to connect to Redis: {e}")
    logger.warning("Initializing Socket.IO without Redis message queue")

    # Initialize Socket.IO without Redis
    socketio = SocketIO(app, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))

    # Use the simple client as fallback
    redis_client = SimpleRedisClient()

# Upload queue status
upload_tasks = {}

# Celery task for processing uploads
@celery.task(bind=True)
def process_upload_task(self_or_task, project_id, filename, temp_file_path):
    """
    Celery task for processing an uploaded image.
    This runs asynchronously to avoid blocking the main thread.
    """
    # Get task ID
    task_id = getattr(self_or_task, 'id', None) or self_or_task.request.id

    # Use the global Redis client if available, otherwise initialize a new one
    if redis_client and not isinstance(redis_client, SimpleRedisClient):
        task_redis_client = redis_client
        logger.info("Using global Redis client for task")
    else:
        # Initialize Redis client for this task using the retry function
        try:
            logger.info("Initializing new Redis client for task")
            task_redis_client = initialize_redis_with_retries(max_retries=3, initial_delay=2)
        except Exception as e:
            logger.error(f"Failed to connect to Redis for task: {e}")
            # Fall back to the global redis client
            task_redis_client = redis_client

    # Helper function to update progress and publish events
    def update_progress(progress, status='processing', event_type='upload_progress', additional_data=None):
        # Update Redis and publish event in one function
        try:
            # Update task status in Redis
            task_redis_client.hset(f"upload_task:{task_id}", "progress", str(progress))
            if status:
                task_redis_client.hset(f"upload_task:{task_id}", "status", status)

            # Prepare and publish event
            event_data = {
                'task_id': task_id,
                'project_id': project_id,
                'filename': filename,
                'progress': progress,
                'status': status
            }

            # Add any additional data
            if additional_data:
                event_data.update(additional_data)

            # Publish event
            task_redis_client.publish('socketio_events', json.dumps({
                'event': event_type,
                'data': event_data
            }))

            logger.info(f"Task {task_id}: {status} ({progress}%)")
        except Exception as e:
            logger.error(f"Error updating progress: {e}")

    try:
        # Initialize task
        update_progress(0, 'processing')

        # Set up project directories
        project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)
        images_path = os.path.join(project_path, 'images')
        try:
            os.makedirs(images_path, exist_ok=True)
        except Exception as e:
            logger.error(f"Failed to create images directory: {str(e)}")
            update_progress(0, 'failed', 'upload_failed', {'error': f"Failed to create images directory: {str(e)}"})
            return {'success': False, 'error': f"Failed to create images directory: {str(e)}"}

        # Update progress to 25%
        update_progress(25)

        # Copy file from temp location to final destination using a streaming approach
        # to avoid loading the entire file into memory
        file_path = os.path.join(images_path, filename)
        try:
            with open(temp_file_path, 'rb') as src_file:
                try:
                    with open(file_path, 'wb') as dst_file:
                        # Copy in chunks of 1MB to avoid memory issues
                        chunk_size = 1024 * 1024  # 1MB
                        while True:
                            try:
                                chunk = src_file.read(chunk_size)
                                if not chunk:
                                    break
                                dst_file.write(chunk)
                            except Exception as e:
                                logger.error(f"Error during file copy operation: {str(e)}")
                                update_progress(0, 'failed', 'upload_failed', {'error': f"Error during file copy operation: {str(e)}"})
                                return {'success': False, 'error': f"Error during file copy operation: {str(e)}"}
                except Exception as e:
                    logger.error(f"Failed to open destination file for writing: {str(e)}")
                    update_progress(0, 'failed', 'upload_failed', {'error': f"Failed to open destination file for writing: {str(e)}"})
                    return {'success': False, 'error': f"Failed to open destination file for writing: {str(e)}"}
        except Exception as e:
            logger.error(f"Failed to open source file for reading: {str(e)}")
            update_progress(0, 'failed', 'upload_failed', {'error': f"Failed to open source file for reading: {str(e)}"})
            return {'success': False, 'error': f"Failed to open source file for reading: {str(e)}"}

        # # Set permissions and clean up
        # try:
        #     os.chmod(file_path, 0o666)  # Read and write permissions for all users
        # except Exception as e:
        #     # This is not a critical error - file uploads will still work
        #     # This commonly happens in Docker environments with mounted volumes,
        #     # especially on Windows hosts where the container user doesn't have
        #     # permission to change file modes in the mounted volume
        #     logger.info(f"Non-critical: Could not set file permissions: {str(e)}")
        #     # Continue with the upload process regardless of permission errors

        # Remove temp file
        try:
            os.remove(temp_file_path)
        except Exception as e:
            # If we can't remove the temp file, log it but continue
            logger.warning(f"Could not remove temporary file {temp_file_path}: {str(e)}")
            # This is not a critical error - the upload has already been processed

        # Update progress to 75%
        update_progress(75)

        # Create image info
        image_info = {
            'name': filename,
            'path': file_path,
            'uploaded': datetime.now().isoformat()
        }

        # Store image info and mark as completed
        task_redis_client.hset(f"upload_task:{task_id}", "image_info", json.dumps(image_info))
        update_progress(100, 'completed', 'upload_completed', {'image_info': image_info})

        return {'success': True, 'image': image_info}

    except Exception as e:
        # Handle errors
        logger.error(f"Error processing upload: {e}")
        update_progress(0, 'failed', 'upload_failed', {'error': str(e)})
        return {'success': False, 'error': str(e)}

# Routes
@app.route('/')
def index():
    """Home page with project management"""
    return render_template('index.html')

@app.route('/projects', methods=['GET', 'POST'])
def projects():
    """API for project management"""
    if request.method == 'GET':
        # List all projects
        projects = []
        if os.path.exists(app.config['PROJECTS_FOLDER']):
            for project_name in os.listdir(app.config['PROJECTS_FOLDER']):
                project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_name)
                if os.path.isdir(project_path):
                    config_path = os.path.join(project_path, 'config.json')
                    if os.path.exists(config_path):
                        try:
                            with open(config_path, 'r') as f:
                                config = json.load(f)
                        except (json.JSONDecodeError, IOError) as e:
                            logger.error(f"Error reading config file for project {project_name}: {str(e)}")
                            continue

                        # Count images by scanning the directory
                        image_count = 0
                        images_path = os.path.join(project_path, 'images')
                        if os.path.exists(images_path):
                            for filename in os.listdir(images_path):
                                if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                                    file_path = os.path.join(images_path, filename)
                                    if os.path.isfile(file_path):
                                        image_count += 1

                        # Count annotations per class
                        annotations_count = {}
                        classes = config.get('classes', [])
                        for i, class_name in enumerate(classes):
                            annotations_count[class_name] = 0

                        # Scan annotation files
                        annotations_path = os.path.join(project_path, 'annotations')
                        if os.path.exists(annotations_path):
                            for filename in os.listdir(annotations_path):
                                if filename.endswith('.json'):
                                    annotation_file = os.path.join(annotations_path, filename)
                                    try:
                                        with open(annotation_file, 'r') as ann_file:
                                            annotations = json.load(ann_file)
                                            for annotation in annotations:
                                                class_idx = annotation.get('class', 0)
                                                if class_idx is not None and 0 <= class_idx < len(classes):
                                                    class_name = classes[class_idx]
                                                    annotations_count[class_name] = annotations_count.get(class_name, 0) + 1
                                    except (json.JSONDecodeError, IOError):
                                        pass

                        projects.append({
                            'id': project_name,
                            'name': config.get('name', project_name),
                            'created': config.get('created', ''),
                            'classes': config.get('classes', []),
                            'classColors': config.get('classColors', {}),
                            'imageCount': image_count,
                            'annotationsCount': annotations_count
                        })
        return jsonify(projects)

    elif request.method == 'POST':
        # Create new project
        data = request.json
        project_name = data.get('name', '').strip()
        classes = data.get('classes', [])
        class_colors = data.get('classColors', {})

        if not project_name:
            return jsonify({'error': 'Project name is required'}), 400

        # Create unique project ID
        project_id = str(uuid.uuid4())
        project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

        # Create project directory structure
        os.makedirs(project_path, exist_ok=True)
        os.makedirs(os.path.join(project_path, 'images'), exist_ok=True)
        os.makedirs(os.path.join(project_path, 'annotations'), exist_ok=True)
        os.makedirs(os.path.join(project_path, 'export'), exist_ok=True)

        # Create project config
        config = {
            'name': project_name,
            'created': datetime.now().isoformat(),
            'classes': classes,
            'classColors': class_colors
        }

        with open(os.path.join(project_path, 'config.json'), 'w') as f:
            json.dump(config, f)

        return jsonify({
            'id': project_id,
            'name': project_name,
            'created': config['created'],
            'classes': classes,
            'classColors': class_colors
        })

    return jsonify({'error': 'Invalid request method.'})

@app.route('/projects/<project_id>', methods=['GET', 'PUT', 'DELETE'])
def project(project_id):
    """API for individual project operations"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    config_path = os.path.join(project_path, 'config.json')

    if request.method == 'GET':
        # Get project details
        with open(config_path, 'r') as f:
            config = json.load(f)

        # Get list of images
        images = []
        image_count = 0
        images_path = os.path.join(project_path, 'images')
        if os.path.exists(images_path):
            for filename in os.listdir(images_path):
                if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                    file_path = os.path.join(images_path, filename)
                    if os.path.isfile(file_path):
                        images.append(filename)
                        image_count += 1

        # Count annotations per class
        annotations_count = {}
        classes = config.get('classes', [])
        for i, class_name in enumerate(classes):
            annotations_count[class_name] = 0

        # Scan annotation files
        annotations_path = os.path.join(project_path, 'annotations')
        if os.path.exists(annotations_path):
            for filename in os.listdir(annotations_path):
                if filename.endswith('.json'):
                    annotation_file = os.path.join(annotations_path, filename)
                    try:
                        with open(annotation_file, 'r') as ann_file:
                            annotations = json.load(ann_file)
                            for annotation in annotations:
                                class_idx = annotation.get('class', 0)
                                if class_idx is not None and 0 <= class_idx < len(classes):
                                    class_name = classes[class_idx]
                                    annotations_count[class_name] = annotations_count.get(class_name, 0) + 1
                    except (json.JSONDecodeError, IOError):
                        pass

        return jsonify({
            'id': project_id,
            'name': config.get('name', ''),
            'created': config.get('created', ''),
            'classes': config.get('classes', []),
            'classColors': config.get('classColors', {}),
            'images': images,
            'imageCount': image_count,
            'annotationsCount': annotations_count
        })

    elif request.method == 'PUT':
        # Update project
        data = request.json

        with open(config_path, 'r') as f:
            config = json.load(f)

        if 'name' in data:
            config['name'] = data['name']

        if 'classes' in data:
            config['classes'] = data['classes']

        if 'classColors' in data:
            config['classColors'] = data['classColors']

        with open(config_path, 'w') as f:
            json.dump(config, f)

        return jsonify({
            'id': project_id,
            'name': config['name'],
            'created': config['created'],
            'classes': config['classes'],
            'classColors': config.get('classColors', {})
        })

    elif request.method == 'DELETE':
        # Delete project (this is dangerous, consider adding confirmation)
        import shutil
        shutil.rmtree(project_path)
        return jsonify({'success': True})
    return jsonify({'error': 'Invalid request method.'})


@app.route('/projects/<project_id>/counts', methods=['GET'])
def project_counts(project_id):
    """API for getting just the image and annotation counts for a project"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    config_path = os.path.join(project_path, 'config.json')

    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        return jsonify({'error': f'Failed to read project config: {str(e)}'}), 500

    # Count images
    image_count = 0
    images_path = os.path.join(project_path, 'images')
    if os.path.exists(images_path):
        for filename in os.listdir(images_path):
            if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                file_path = os.path.join(images_path, filename)
                if os.path.isfile(file_path):
                    image_count += 1

    # Count annotations per class
    annotations_count = {}
    classes = config.get('classes', [])
    for i, class_name in enumerate(classes):
        annotations_count[class_name] = 0

    # Scan annotation files
    annotations_path = os.path.join(project_path, 'annotations')
    if os.path.exists(annotations_path):
        for filename in os.listdir(annotations_path):
            if filename.endswith('.json'):
                annotation_file = os.path.join(annotations_path, filename)
                try:
                    with open(annotation_file, 'r') as ann_file:
                        annotations = json.load(ann_file)
                        for annotation in annotations:
                            class_idx = annotation.get('class', 0)
                            if class_idx is not None and 0 <= class_idx < len(classes):
                                class_name = classes[class_idx]
                                annotations_count[class_name] = annotations_count.get(class_name, 0) + 1
                except (json.JSONDecodeError, IOError):
                    pass

    return jsonify({
        'imageCount': image_count,
        'annotationsCount': annotations_count
    })

@app.route('/projects/<project_id>/images', methods=['GET', 'POST'])
def project_images(project_id):
    """API for project images list"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    images_path = os.path.join(project_path, 'images')
    os.makedirs(images_path, exist_ok=True)

    if request.method == 'GET':
        # Scan the images directory and return a list of all image files
        images = []
        if os.path.exists(images_path):
            for filename in os.listdir(images_path):
                if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                    file_path = os.path.join(images_path, filename)
                    if os.path.isfile(file_path):
                        # Create image info object
                        image_info = {
                            'name': filename,
                            'path': file_path,
                            'uploaded': datetime.fromtimestamp(os.path.getctime(file_path)).isoformat()
                        }
                        images.append(image_info)

        # Sort images by creation time (newest first)
        images.sort(key=lambda x: x['uploaded'], reverse=True)

        return jsonify({'images': images})

    elif request.method == 'POST':
        # We still accept POST requests to maintain compatibility
        # but we don't save to images_list.json anymore
        return jsonify({'success': True})

    return jsonify({'error': 'Invalid request method.'})

@app.route('/projects/<project_id>/upload', methods=['POST'])
def upload_image(project_id):
    """API for uploading images to the project"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # Check if file was uploaded
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']

    # If user does not select file, browser also
    # submit an empty part without filename
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if file:
        # Secure the filename to prevent directory traversal attacks
        filename = os.path.basename(file.filename)

        # Create a temporary file to store the upload
        temp_dir = os.path.join(app.config['PROJECTS_FOLDER'], 'temp')
        os.makedirs(temp_dir, exist_ok=True)

        # # Ensure the temp directory has the correct permissions
        # try:
        #     os.chmod(temp_dir, 0o777)
        # except Exception as e:
        #     # This is not a critical error - uploads will still work
        #     # This commonly happens in Docker environments with mounted volumes,
        #     # especially on Windows hosts where the container user doesn't have
        #     # permission to change file modes in the mounted volume
        #     logger.info(f"Non-critical: Could not set temp directory permissions: {str(e)}")
        #     # Continue with the upload process regardless of permission errors

        temp_file_path = os.path.join(temp_dir, f"{uuid.uuid4()}_{filename}")

        # Save the file to the temporary location
        try:
            file.save(temp_file_path)
        except Exception as e:
            logger.error(f"Failed to save uploaded file to temporary location: {str(e)}")
            return jsonify({'error': f'Failed to save uploaded file: {str(e)}'}), 500

        # # Ensure the temporary file has the correct permissions
        # try:
        #     os.chmod(temp_file_path, 0o666)  # Read and write permissions for all users
        # except Exception as e:
        #     # This is not a critical error - uploads will still work
        #     # This commonly happens in Docker environments with mounted volumes,
        #     # especially on Windows hosts where the container user doesn't have
        #     # permission to change file modes in the mounted volume
        #     logger.info(f"Non-critical: Could not set temporary file permissions: {str(e)}")
        #     # Continue with the upload process regardless of permission errors

        # Queue the processing task
        task = process_upload_task.delay(project_id, filename, temp_file_path)
        task_id = task.id

        # Store task info
        upload_tasks[task_id] = {
            'project_id': project_id,
            'filename': filename,
            'status': 'queued',
            'created': datetime.now().isoformat()
        }

        # Store initial task status in Redis
        redis_client.hset(f"upload_task:{task_id}", "status", "queued")
        redis_client.hset(f"upload_task:{task_id}", "progress", "0")
        redis_client.hset(f"upload_task:{task_id}", "filename", filename)
        redis_client.hset(f"upload_task:{task_id}", "project_id", project_id)
        redis_client.hset(f"upload_task:{task_id}", "created", datetime.now().isoformat())

        # Return task ID for client to track progress
        return jsonify({
            'success': True,
            'task_id': task_id,
            'status': 'queued'
        })

    return jsonify({'error': 'Failed to upload file'}), 500

@app.route('/projects/<project_id>/upload/status/<task_id>', methods=['GET'])
def upload_status(project_id, task_id):
    """API for checking upload status"""
    # Check if task exists in Redis
    if not redis_client.exists(f"upload_task:{task_id}"):
        return jsonify({'error': 'Task not found'}), 404

    # Get task status from Redis
    status = redis_client.hget(f"upload_task:{task_id}", "status").decode('utf-8')
    progress = redis_client.hget(f"upload_task:{task_id}", "progress").decode('utf-8')

    response = {
        'task_id': task_id,
        'status': status,
        'progress': progress
    }

    # If task is completed, include image info
    if status == 'completed':
        image_info_json = redis_client.hget(f"upload_task:{task_id}", "image_info")
        if image_info_json:
            response['image_info'] = json.loads(image_info_json)

    # If task failed, include error message
    if status == 'failed':
        error = redis_client.hget(f"upload_task:{task_id}", "error")
        if error:
            response['error'] = error.decode('utf-8')

    return jsonify(response)

@app.route('/projects/<project_id>/uploads/pending', methods=['GET'])
def pending_uploads(project_id):
    """API for getting all pending uploads for a project"""
    pending_tasks = []

    # Get all tasks for this project
    for task_id, task_info in upload_tasks.items():
        if task_info.get('project_id') == project_id:
            # Get current status from Redis
            if redis_client.exists(f"upload_task:{task_id}"):
                status = redis_client.hget(f"upload_task:{task_id}", "status").decode('utf-8')
                progress = redis_client.hget(f"upload_task:{task_id}", "progress").decode('utf-8')

                task_info['status'] = status
                task_info['progress'] = progress

                # Only include tasks that are not completed or failed
                if status not in ['completed', 'failed']:
                    pending_tasks.append({
                        'task_id': task_id,
                        **task_info
                    })

    return jsonify(pending_tasks)

@app.route('/projects/<project_id>/annotations/<image_name>', methods=['GET', 'POST'])
def annotations(project_id, image_name):
    """API for image annotations"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # URL-decode the image name
    import urllib.parse
    decoded_image_name = urllib.parse.unquote(image_name)

    annotations_path = os.path.join(project_path, 'annotations')
    os.makedirs(annotations_path, exist_ok=True)

    annotation_file = os.path.join(annotations_path, f"{os.path.splitext(decoded_image_name)[0]}.json")

    if request.method == 'GET':
        # Get annotations for an image
        if os.path.exists(annotation_file):
            with open(annotation_file, 'r') as f:
                return jsonify(json.load(f))
        return jsonify([])

    elif request.method == 'POST':
        # Save annotations for an image
        annotations = request.json

        with open(annotation_file, 'w') as f:
            json.dump(annotations, f)

        return jsonify({'success': True})

@app.route('/projects/<project_id>/filtered_images', methods=['GET'])
def get_filtered_images(project_id):
    """Get filtered images based on tab"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # Get the tab parameter from the query string
    tab = request.args.get('tab', 'all-images')

    # Get all images
    images_path = os.path.join(project_path, 'images')
    os.makedirs(images_path, exist_ok=True)

    all_images = []
    if os.path.exists(images_path):
        for filename in os.listdir(images_path):
            if filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp')):
                file_path = os.path.join(images_path, filename)
                if os.path.isfile(file_path):
                    # Create image info object
                    image_info = {
                        'name': filename,
                        'path': file_path,
                        'uploaded': datetime.fromtimestamp(os.path.getctime(file_path)).isoformat()
                    }
                    all_images.append(image_info)

    # Sort images by creation time (newest first)
    all_images.sort(key=lambda x: x['uploaded'], reverse=True)

    # If tab is 'all-images', return all images
    if tab == 'all-images':
        return jsonify({'images': all_images})

    # For other tabs, we need to check annotations
    annotations_path = os.path.join(project_path, 'annotations')
    os.makedirs(annotations_path, exist_ok=True)

    annotated_images = []
    unannotated_images = []
    background_images = []

    # Check each image for annotations
    for image in all_images:
        image_name = image['name']
        annotation_file = os.path.join(annotations_path, f"{os.path.splitext(image_name)[0]}.json")

        if os.path.exists(annotation_file):
            with open(annotation_file, 'r') as f:
                try:
                    annotations = json.load(f)
                    if annotations and len(annotations) > 0:
                        annotated_images.append(image)

                        # Check if it has a background annotation
                        has_background = any(annotation.get('type') == 'background' for annotation in annotations)
                        if has_background:
                            background_images.append(image)
                except json.JSONDecodeError:
                    # If the file is not valid JSON, consider it unannotated
                    unannotated_images.append(image)
        else:
            unannotated_images.append(image)

    # Return images based on the tab
    if tab == 'annotated-images':
        return jsonify({'images': annotated_images})
    elif tab == 'unannotated-images':
        return jsonify({'images': unannotated_images})
    elif tab == 'background-images':
        return jsonify({'images': background_images})
    else:
        # Default to all images
        return jsonify({'images': all_images})

@app.route('/projects/<project_id>/mark_as_background', methods=['POST'])
def mark_as_background(project_id):
    """Mark an image as background (no objects)"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # Get the image name from the request
    data = request.json
    image_name = data.get('image_name')

    if not image_name:
        return jsonify({'error': 'No image name provided'}), 400

    # URL-decode the image name
    import urllib.parse
    decoded_image_name = urllib.parse.unquote(image_name)

    # Create the annotations directory if it doesn't exist
    annotations_path = os.path.join(project_path, 'annotations')
    os.makedirs(annotations_path, exist_ok=True)

    # Create a background annotation
    background_annotation = [{
        "type": "background",
        "class": None,
        "points": []
    }]

    # Save the background annotation
    annotation_file = os.path.join(annotations_path, f"{os.path.splitext(decoded_image_name)[0]}.json")
    with open(annotation_file, 'w') as f:
        json.dump(background_annotation, f)

    return jsonify({'success': True})

@app.route('/projects/<project_id>/navigate_image', methods=['GET'])
def navigate_image(project_id):
    """Navigate to previous or next image"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # Get parameters from the query string
    current_image = request.args.get('current_image', '')
    direction = request.args.get('direction', 'next')  # 'next' or 'previous'
    tab = request.args.get('tab', 'all-images')

    # Get filtered images based on the tab
    filtered_images_response = get_filtered_images(project_id)
    filtered_images_data = filtered_images_response.json
    filtered_images = filtered_images_data.get('images', [])

    if not filtered_images:
        return jsonify({'error': 'No images found'}), 404

    # Find the index of the current image
    current_index = -1
    for i, image in enumerate(filtered_images):
        if image['name'] == current_image:
            current_index = i
            break

    # If current image not found, return the first image
    if current_index == -1:
        return jsonify({'image': filtered_images[0]})

    # Calculate the index of the previous/next image (with wrap-around)
    if direction == 'previous':
        new_index = (current_index - 1) % len(filtered_images)
    else:  # direction == 'next'
        new_index = (current_index + 1) % len(filtered_images)

    # Return the new image
    return jsonify({'image': filtered_images[new_index]})

@app.route('/projects/<project_id>/export', methods=['POST'])
def export_project(project_id):
    """Export project in YOLO format"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # Load project config
    with open(os.path.join(project_path, 'config.json'), 'r') as f:
        config = json.load(f)

    classes = config.get('classes', [])

    # Create export directories
    export_path = os.path.join(project_path, 'export')
    os.makedirs(export_path, exist_ok=True)

    train_images_path = os.path.join(export_path, 'train', 'images')
    train_labels_path = os.path.join(export_path, 'train', 'labels')
    val_images_path = os.path.join(export_path, 'val', 'images')
    val_labels_path = os.path.join(export_path, 'val', 'labels')

    os.makedirs(train_images_path, exist_ok=True)
    os.makedirs(train_labels_path, exist_ok=True)
    os.makedirs(val_images_path, exist_ok=True)
    os.makedirs(val_labels_path, exist_ok=True)

    # Create data.yaml
    data_yaml = f"""train: train/images
val: val/images
nc: {len(classes)}
names: {json.dumps(classes)}
"""

    with open(os.path.join(export_path, 'data.yaml'), 'w') as f:
        f.write(data_yaml)

    # For now, we'll just return success - actual export would copy images and convert annotations
    return jsonify({
        'success': True,
        'message': 'Export structure created. In a real implementation, this would also convert and copy the annotations.'
    })

@app.route('/projects/<project_id>/images/<filename>')
def serve_image(project_id, filename):
    """Serve an image from the project's images directory"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return "Project not found", 404

    # URL-decode the filename
    import urllib.parse
    decoded_filename = urllib.parse.unquote(filename)

    images_path = os.path.join(project_path, 'images')
    response = send_from_directory(images_path, decoded_filename)

    # Add cache-control headers to prevent browser caching
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'

    return response

@app.route('/projects/<project_id>/images/<filename>', methods=['DELETE'])
def delete_image(project_id, filename):
    """Delete an image from the project"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    # URL-decode the filename
    import urllib.parse
    decoded_filename = urllib.parse.unquote(filename)

    images_path = os.path.join(project_path, 'images')
    image_path = os.path.join(images_path, decoded_filename)

    # Check if image exists
    if not os.path.exists(image_path):
        return jsonify({'error': 'Image not found'}), 404

    # Delete the image file
    try:
        os.remove(image_path)
    except Exception as e:
        return jsonify({'error': f'Failed to delete image file: {str(e)}'}), 500

    # We no longer use images_list.json

    # Delete any associated annotations
    annotations_path = os.path.join(project_path, 'annotations')
    annotation_file = os.path.join(annotations_path, f"{os.path.splitext(filename)[0]}.json")
    if os.path.exists(annotation_file):
        try:
            os.remove(annotation_file)
        except Exception as e:
            logger.warning(f"Failed to delete annotation file: {str(e)}")

    return jsonify({'success': True, 'message': 'Image deleted successfully'})

@app.route('/annotate/<project_id>')
def annotate(project_id):
    """Annotation interface for a specific project"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return "Project not found", 404

    with open(os.path.join(project_path, 'config.json'), 'r') as f:
        config = json.load(f)

    return render_template('annotate.html', project_id=project_id, project_name=config.get('name', ''), classes=config.get('classes', []))

@app.route('/socket.io.js')
def serve_socketio_client():
    """Serve the Socket.IO client library"""
    return send_from_directory('node_modules/socket.io-client/dist', 'socket.io.js')



if __name__ == '__main__':
    socketio.run(app, debug=True)
