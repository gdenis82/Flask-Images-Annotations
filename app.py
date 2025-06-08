from flask import Flask, render_template, request, jsonify, session, send_from_directory
import os
import json
import uuid
import sys
from datetime import datetime
from PIL import Image
import io
import base64
import logging
import redis
import threading
from celery import Celery
from flask_socketio import SocketIO

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Flask app setup
app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', os.urandom(24))
app.config['PROJECTS_FOLDER'] = os.getenv('PROJECTS_FOLDER', 'projects')

# Celery configuration
app.config.update(
    CELERY_BROKER_URL=os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0'),
    CELERY_RESULT_BACKEND=os.getenv('CELERY_RESULT_BACKEND', 'redis://localhost:6379/0'),
    BROKER_URL=os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0'),
    RESULT_BACKEND=os.getenv('CELERY_RESULT_BACKEND', 'redis://localhost:6379/0')
)

# Initialize Celery
def make_celery(app):
    celery = Celery(
        app.import_name,
        backend=app.config['RESULT_BACKEND'],
        broker=app.config['BROKER_URL']
    )
    celery.conf.update(app.config)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return self.run(*args, **kwargs)

    celery.Task = ContextTask
    return celery

celery = make_celery(app)

# Initialize SocketIO
# We'll initialize it with None first, then properly initialize it in delayed_redis_init
# after Redis is connected
socketio = None

# Initialize Redis for storing upload status
redis_host = os.getenv('REDIS_HOST', 'redis')
redis_port = int(os.getenv('REDIS_PORT', 6379))
redis_db = int(os.getenv('REDIS_RESULT_DB', 0))

# Define a more robust in-memory store as fallback
class DummyRedisClient:
    def __init__(self):
        self.data = {}
        self.pubsub_channels = {}
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
        if channel in self.pubsub_channels:
            for callback in self.pubsub_channels[channel]:
                try:
                    callback(message)
                except Exception as e:
                    logger.error(f"Error in pubsub callback: {e}")
        return 0

    def ping(self):
        return True

    def pubsub(self):
        """Return a dummy pubsub client"""
        return DummyPubSub(self)

    def __getattr__(self, name):
        # Handle any other Redis methods by returning a no-op function
        def dummy_method(*args, **kwargs):
            logger.debug(f"Dummy Redis method called: {name}")
            return None
        return dummy_method

class DummyPubSub:
    def __init__(self, parent):
        self.parent = parent
        self.channels = set()

    def subscribe(self, *channels):
        """Subscribe to channels"""
        for channel in channels:
            self.channels.add(channel)
            if channel not in self.parent.pubsub_channels:
                self.parent.pubsub_channels[channel] = []
        logger.info(f"Subscribed to channels: {channels}")
        return True

    def listen(self):
        """Simulate listening for messages"""
        # This will just block indefinitely since we don't have real messages
        logger.info("DummyPubSub listening for messages (this will block indefinitely)")
        import time
        while True:
            time.sleep(3600)  # Sleep for an hour

    def close(self):
        """Close the pubsub connection"""
        logger.info("Closing DummyPubSub connection")
        return True

# Initialize Redis client with None, will be set up later
redis_client = None

# Function to initialize Redis with retries and fallback
def delayed_redis_init():
    global redis_client
    global socketio
    import socket
    import time

    # Wait longer to give DNS time to resolve
    logger.info("Waiting 30 seconds before initializing Redis connections...")
    time.sleep(30)

    # Get system information for debugging
    logger.info(f"System hostname: {socket.gethostname()}")
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Redis configuration - Host: {redis_host}, Port: {redis_port}, DB: {redis_db}")

    # Log network interfaces for debugging
    try:
        import netifaces
        interfaces = netifaces.interfaces()
        logger.info(f"Network interfaces: {interfaces}")
        for iface in interfaces:
            try:
                addrs = netifaces.ifaddresses(iface)
                if netifaces.AF_INET in addrs:
                    for addr in addrs[netifaces.AF_INET]:
                        logger.info(f"Interface {iface} - IPv4: {addr['addr']}, Netmask: {addr['netmask']}")
            except Exception as e:
                logger.error(f"Error getting interface info for {iface}: {e}")
    except ImportError:
        logger.warning("netifaces module not available, skipping network interface info")
    except Exception as e:
        logger.error(f"Error getting network interfaces: {e}")

    # Try to resolve Redis hostname using DNS
    redis_ip = None
    try:
        logger.info(f"Attempting to resolve Redis hostname '{redis_host}' using standard DNS...")
        redis_ip = socket.gethostbyname(redis_host)
        logger.info(f"Standard DNS resolution: {redis_host} -> {redis_ip}")
    except Exception as e:
        logger.error(f"Standard DNS resolution failed for '{redis_host}': {e}")

        # Try to ping the Redis host
        try:
            logger.info(f"Attempting to ping Redis host '{redis_host}'...")
            import subprocess
            result = subprocess.run(['ping', '-c', '1', redis_host], 
                                   stdout=subprocess.PIPE, 
                                   stderr=subprocess.PIPE,
                                   text=True)
            logger.info(f"Ping successful: {result.stdout}")

            # If ping is successful but DNS failed, try to extract IP from ping output
            if "bytes from" in result.stdout:
                import re
                # Try to match IP in parentheses first (common in ping output)
                ip_match = re.search(r'\(([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\)', result.stdout)
                if not ip_match:
                    # Fallback to the original pattern
                    ip_match = re.search(r'bytes from ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)', result.stdout)
                if ip_match:
                    redis_ip = ip_match.group(1)
                    logger.info(f"Extracted Redis IP from ping: {redis_ip}")

                    # Try to add the IP to /etc/hosts for better DNS resolution
                    try:
                        with open('/etc/hosts', 'a') as hosts_file:
                            hosts_file.write(f"\n{redis_ip} {redis_host}\n")
                        logger.info(f"Added {redis_ip} {redis_host} to /etc/hosts file")
                    except Exception as hosts_error:
                        logger.error(f"Error updating /etc/hosts file: {hosts_error}")
        except Exception as ping_error:
            logger.error(f"Error pinging Redis host: {ping_error}")

    # Initialize Redis client with retries
    max_retries = 10  # Increased from 5 to give more chances for connection
    retry_delay = 5   # Increased from 3 seconds to give more time between retries

    logger.info("Starting Redis client initialization...")
    logger.info(f"Attempting to connect to Redis at {redis_host}:{redis_port}")

    # Try connecting using IP address first if we have it
    if redis_ip:
        logger.info(f"Attempting to connect using resolved IP: {redis_ip}")
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Redis connection using IP, attempt {attempt}/{max_retries} to {redis_ip}:{redis_port}")
                client = redis.Redis(
                    host=redis_ip,
                    port=redis_port,
                    db=redis_db,
                    socket_timeout=60,  # Increased from 30 to 60 seconds
                    socket_connect_timeout=60,  # Increased from 30 to 60 seconds
                    health_check_interval=60,  # Increased from 30 to 60 seconds
                    retry_on_timeout=True,
                    decode_responses=False
                )
                # Test connection
                client.ping()
                logger.info(f"Successfully connected to Redis at {redis_ip}:{redis_port}")
                redis_client = client

                # Initialize Socket.IO with Redis
                try:
                    # Configure Socket.IO to use Redis
                    message_queue = f"redis://{redis_ip}:{redis_port}/0"
                    if socketio is None:
                        from flask_socketio import SocketIO
                        socketio = SocketIO(app, message_queue=message_queue, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
                        logger.info(f"Successfully initialized Socket.IO with Redis message queue: {message_queue}")
                    else:
                        logger.info(f"Socket.IO already initialized")
                except Exception as socketio_error:
                    logger.error(f"Error initializing Socket.IO with Redis: {socketio_error}")
                    # Initialize Socket.IO without Redis as fallback
                    if socketio is None:
                        from flask_socketio import SocketIO
                        socketio = SocketIO(app, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
                        logger.warning("Initialized Socket.IO without Redis message queue support")

                break
            except Exception as e:
                logger.error(f"Redis connection error using IP: {e}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    logger.error("Failed to connect to Redis using IP address")
                    # Fall through to try hostname method

    # If IP connection failed or we don't have an IP, try hostname
    if redis_client is None:
        retry_delay = 5  # Reset retry delay (increased from 3 to 5 seconds)
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Redis connection using hostname, attempt {attempt}/{max_retries} to {redis_host}:{redis_port}")
                client = redis.Redis(
                    host=redis_host,
                    port=redis_port,
                    db=redis_db,
                    socket_timeout=60,  # Increased from 30 to 60 seconds
                    socket_connect_timeout=60,  # Increased from 30 to 60 seconds
                    health_check_interval=60,  # Increased from 30 to 60 seconds
                    retry_on_timeout=True,
                    decode_responses=False
                )
                # Test connection
                client.ping()
                logger.info(f"Successfully connected to Redis at {redis_host}:{redis_port}")
                redis_client = client

                # Initialize Socket.IO with Redis
                try:
                    # Configure Socket.IO to use Redis
                    message_queue = f"redis://{redis_host}:{redis_port}/0"
                    if socketio is None:
                        from flask_socketio import SocketIO
                        socketio = SocketIO(app, message_queue=message_queue, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
                        logger.info(f"Successfully initialized Socket.IO with Redis message queue: {message_queue}")
                    else:
                        logger.info(f"Socket.IO already initialized")
                except Exception as socketio_error:
                    logger.error(f"Error initializing Socket.IO with Redis: {socketio_error}")
                    # Initialize Socket.IO without Redis as fallback
                    if socketio is None:
                        from flask_socketio import SocketIO
                        socketio = SocketIO(app, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
                        logger.warning("Initialized Socket.IO without Redis message queue support")

                break
            except Exception as e:
                logger.error(f"Redis connection error using hostname: {e}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    logger.error("Failed to connect to Redis using hostname")

                    # Try one more time with direct IP if we have it from ping
                    if redis_ip:
                        logger.info(f"Trying one last direct connection attempt with IP: {redis_ip}")
                        try:
                            # Connect directly to the IP with increased timeout
                            direct_client = redis.Redis(
                                host=redis_ip,
                                port=redis_port,
                                db=redis_db,
                                socket_timeout=120,  # Very long timeout for last attempt
                                socket_connect_timeout=120,
                                health_check_interval=60,
                                retry_on_timeout=True,
                                decode_responses=False
                            )
                            # Test connection
                            direct_client.ping()
                            logger.info(f"Successfully connected to Redis at {redis_ip}:{redis_port} with direct IP connection")
                            redis_client = direct_client

                            # Initialize Socket.IO with Redis
                            try:
                                message_queue = f"redis://{redis_ip}:{redis_port}/0"
                                if socketio is None:
                                    from flask_socketio import SocketIO
                                    socketio = SocketIO(app, message_queue=message_queue, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
                                    logger.info(f"Successfully initialized Socket.IO with Redis message queue: {message_queue}")
                            except Exception as socketio_error:
                                logger.error(f"Error initializing Socket.IO with Redis: {socketio_error}")
                        except Exception as direct_error:
                            logger.error(f"Final direct IP connection attempt failed: {direct_error}")

    # If all connection attempts failed, use the dummy client
    if redis_client is None:
        logger.warning("All Redis connection attempts failed, using in-memory store")
        redis_client = DummyRedisClient()

    # Make sure SocketIO is initialized even if Redis connection failed
    if socketio is None:
        from flask_socketio import SocketIO
        socketio = SocketIO(app, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
        logger.warning("Initialized Socket.IO without Redis message queue support")

    # Initialize Redis pubsub for Socket.IO events
    if not isinstance(redis_client, DummyRedisClient):
        # Wait a bit before initializing pubsub
        logger.info("Waiting 6 seconds before initializing Redis pubsub...")
        time.sleep(6)

        # Initialize pubsub with retries
        retry_delay = 3  # Reset retry delay
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Attempting to connect to Redis pubsub at {redis_host}:{redis_port}")
                logger.info(f"Redis pubsub connection attempt {attempt}/{max_retries}")

                # Create a pubsub client
                pubsub_client = redis_client.pubsub()

                # Test connection with ping
                logger.info("Testing Redis pubsub connection with ping...")
                redis_client.ping()

                # Subscribe to the socketio_events channel
                logger.info("Creating pubsub client and subscribing to socketio_events channel...")
                pubsub_client.subscribe('socketio_events')

                # Start a background thread to listen for messages
                def handle_pubsub_messages():
                    try:
                        logger.info("Starting pubsub message listener thread")
                        logger.info(f"Pubsub thread ID: {threading.get_ident()}")
                        logger.info(f"Pubsub connection details: {pubsub_client.connection}")

                        # Heartbeat counter for monitoring
                        message_count = 0
                        last_heartbeat = time.time()

                        for message in pubsub_client.listen():
                            try:
                                # Send heartbeat log every 60 seconds
                                if time.time() - last_heartbeat > 60:
                                    logger.info(f"Pubsub thread heartbeat - Thread ID: {threading.get_ident()}, Messages processed: {message_count}")
                                    last_heartbeat = time.time()

                                if message['type'] == 'message':
                                    message_count += 1
                                    data = json.loads(message['data'].decode('utf-8'))
                                    event = data.get('event')
                                    event_data = data.get('data')

                                    if event and event_data:
                                        # Emit the event to all connected clients
                                        socketio.emit(event, event_data)
                                        logger.info(f"Emitted {event} event from Redis pubsub")
                            except Exception as e:
                                logger.error(f"Error processing pubsub message: {e}")
                    except Exception as e:
                        logger.error(f"Error in pubsub listener thread: {e}")

                # Start the pubsub listener thread
                logger.info("Starting pubsub message listener thread")
                pubsub_thread = threading.Thread(target=handle_pubsub_messages, daemon=True)
                pubsub_thread.start()
                logger.info("Started pubsub listener thread")
                logger.info("Successfully connected to Redis pubsub at redis:6379")

                # Break out of retry loop on success
                break
            except Exception as e:
                logger.error(f"Redis pubsub connection error: {e}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    logger.error("Failed to connect to Redis pubsub after multiple attempts")

    # Set up periodic health check for Redis connections
    def check_redis_health():
        """Periodically check Redis connections and reconnect if needed"""
        global redis_client

        while True:
            try:
                # Wait between checks
                time.sleep(30)

                # Skip health check if using dummy client
                if isinstance(redis_client, DummyRedisClient):
                    continue

                # Check Redis client connection
                logger.info("Testing Redis client connection with ping...")
                ping_result = redis_client.ping()
                logger.info(f"Redis client ping result: {ping_result}")

                # Check if pubsub thread is alive
                if 'pubsub_thread' in locals() and pubsub_thread.is_alive():
                    logger.info(f"Pubsub thread (ID: {pubsub_thread.ident}) is alive and healthy")

                # Log next check time
                logger.info("Next Redis health check in 30 seconds...")

            except Exception as e:
                logger.error(f"Redis health check failed: {e}")

                # Try to reconnect
                try:
                    logger.info("Attempting to reconnect to Redis...")
                    delayed_redis_init()
                except Exception as reconnect_error:
                    logger.error(f"Failed to reconnect to Redis: {reconnect_error}")

    # Start health check thread
    health_check_thread = threading.Thread(target=check_redis_health, daemon=True)
    health_check_thread.start()

# Start Redis initialization in a background thread
threading.Thread(target=delayed_redis_init, daemon=True).start()

# Upload queue status
upload_tasks = {}

# Celery task for processing uploads
@celery.task(bind=True)
def process_upload_task(self_or_task, project_id, filename, temp_file_path):
    """
    Celery task for processing an uploaded image.
    This runs asynchronously to avoid blocking the main thread.
    """
    # Initialize Redis client for this task
    task_redis_client = redis.Redis(
        host=redis_host,
        port=redis_port,
        db=redis_db,
        socket_timeout=60,
        socket_connect_timeout=60,
        health_check_interval=60,
        retry_on_timeout=True,
        decode_responses=False
    )

    try:
        # Update task status
        # Handle both Celery task instances and mock tasks in tests
        task_id = getattr(self_or_task, 'id', None) or self_or_task.request.id
        task_redis_client.hset(f"upload_task:{task_id}", "status", "processing")
        task_redis_client.hset(f"upload_task:{task_id}", "progress", "0")

        # Get project path
        project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)
        images_path = os.path.join(project_path, 'images')

        # Ensure directories exist
        os.makedirs(images_path, exist_ok=True)

        # Ensure the images directory has the correct permissions
        try:
            os.chmod(images_path, 0o777)
        except Exception as e:
            logger.warning(f"Failed to set permissions on images directory: {str(e)}")

        # Path to the images list JSON file
        images_list_file = os.path.join(images_path, 'images_list.json')

        # Load existing images list
        images_list = {'images': []}
        if os.path.exists(images_list_file):
            try:
                with open(images_list_file, 'r') as f:
                    images_list = json.load(f)
            except json.JSONDecodeError:
                pass

        if 'images' not in images_list:
            images_list['images'] = []

        # Update progress
        task_redis_client.hset(f"upload_task:{task_id}", "progress", "10")

        # Copy file from temp location to final destination
        file_path = os.path.join(images_path, filename)
        with open(temp_file_path, 'rb') as src_file:
            with open(file_path, 'wb') as dst_file:
                dst_file.write(src_file.read())

        # Ensure the file has the correct permissions
        try:
            os.chmod(file_path, 0o666)  # Read and write permissions for all users
        except Exception as e:
            logger.warning(f"Failed to set permissions on file: {str(e)}")

        # Remove temp file
        os.remove(temp_file_path)

        # Update progress
        task_redis_client.hset(f"upload_task:{task_id}", "progress", "50")

        # Create a thumbnail
        thumbnail_data = None
        try:
            # Open the image and create a thumbnail
            img = Image.open(file_path)
            img.thumbnail((100, 100))

            # Save thumbnail to memory
            buffer = io.BytesIO()
            img.save(buffer, format="JPEG")
            thumbnail_data = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode('utf-8')
        except Exception as e:
            logger.error(f"Error creating thumbnail: {e}")

        # Update progress
        task_redis_client.hset(f"upload_task:{task_id}", "progress", "80")

        # Add the image to the list
        image_info = {
            'name': filename,
            'path': file_path,
            'thumbnail': thumbnail_data,
            'uploaded': datetime.now().isoformat()
        }

        # Check if image already exists in the list
        existing_index = None
        for i, img in enumerate(images_list['images']):
            if img.get('name') == filename:
                existing_index = i
                break

        if existing_index is not None:
            # Update existing entry
            images_list['images'][existing_index] = image_info
        else:
            # Add new entry
            images_list['images'].append(image_info)

        # Save the updated images list
        with open(images_list_file, 'w') as f:
            json.dump(images_list, f)

        # Update progress
        task_redis_client.hset(f"upload_task:{task_id}", "progress", "100")
        task_redis_client.hset(f"upload_task:{task_id}", "status", "completed")
        task_redis_client.hset(f"upload_task:{task_id}", "image_info", json.dumps(image_info))

        # Emit event to connected clients via Redis pubsub
        try:
            event_data = {
                'task_id': task_id,
                'project_id': project_id,
                'filename': filename,
                'image_info': image_info
            }
            # Publish the event to the socketio_events channel
            pubsub_message = json.dumps({
                'event': 'upload_completed',
                'data': event_data
            })
            task_redis_client.publish('socketio_events', pubsub_message)
            logger.info(f"Published upload_completed event to Redis pubsub for task {task_id}")
        except Exception as emit_error:
            logger.error(f"Error publishing upload_completed event: {emit_error}")

        return {
            'success': True,
            'image': image_info
        }
    except Exception as e:
        # Update task status on error
        task_redis_client.hset(f"upload_task:{task_id}", "status", "failed")
        task_redis_client.hset(f"upload_task:{task_id}", "error", str(e))

        # Emit event to connected clients via Redis pubsub
        try:
            event_data = {
                'task_id': task_id,
                'project_id': project_id,
                'filename': filename,
                'error': str(e)
            }
            # Publish the event to the socketio_events channel
            pubsub_message = json.dumps({
                'event': 'upload_failed',
                'data': event_data
            })
            task_redis_client.publish('socketio_events', pubsub_message)
            logger.info(f"Published upload_failed event to Redis pubsub for task {task_id}")
        except Exception as emit_error:
            logger.error(f"Error publishing upload_failed event: {emit_error}")

        logger.error(f"Error processing upload: {e}")
        return {
            'success': False,
            'error': str(e)
        }

# Ensure projects directory exists
if not os.path.exists(app.config['PROJECTS_FOLDER']):
    os.makedirs(app.config['PROJECTS_FOLDER'])

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
                        with open(config_path, 'r') as f:
                            config = json.load(f)

                            # Count images
                            image_count = 0
                            images_path = os.path.join(project_path, 'images')
                            images_list_file = os.path.join(images_path, 'images_list.json')
                            if os.path.exists(images_list_file):
                                with open(images_list_file, 'r') as img_file:
                                    try:
                                        images_data = json.load(img_file)
                                        if 'images' in images_data:
                                            image_count = len(images_data['images'])
                                    except json.JSONDecodeError:
                                        pass

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
                                                    if 0 <= class_idx < len(classes):
                                                        class_name = classes[class_idx]
                                                        annotations_count[class_name] = annotations_count.get(class_name, 0) + 1
                                        except (json.JSONDecodeError, IOError):
                                            pass

                            projects.append({
                                'id': project_name,
                                'name': config.get('name', project_name),
                                'created': config.get('created', ''),
                                'classes': config.get('classes', []),
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
        images_path = os.path.join(project_path, 'images')
        if os.path.exists(images_path):
            for filename in os.listdir(images_path):
                if filename.lower().endswith(('.png', '.jpg', '.jpeg')):
                    images.append(filename)

        return jsonify({
            'id': project_id,
            'name': config.get('name', ''),
            'created': config.get('created', ''),
            'classes': config.get('classes', []),
            'classColors': config.get('classColors', {}),
            'images': images
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

@app.route('/projects/<project_id>/images', methods=['GET', 'POST'])
def project_images(project_id):
    """API for project images list"""
    project_path = os.path.join(app.config['PROJECTS_FOLDER'], project_id)

    if not os.path.exists(project_path):
        return jsonify({'error': 'Project not found'}), 404

    images_path = os.path.join(project_path, 'images')
    os.makedirs(images_path, exist_ok=True)

    # Path to the images list JSON file
    images_list_file = os.path.join(images_path, 'images_list.json')

    if request.method == 'GET':
        # Get images list
        if os.path.exists(images_list_file):
            with open(images_list_file, 'r') as f:
                return jsonify(json.load(f))
        return jsonify({'images': []})

    elif request.method == 'POST':
        # Save images list
        images_list = request.json

        with open(images_list_file, 'w') as f:
            json.dump(images_list, f)

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

        # Ensure the temp directory has the correct permissions
        try:
            os.chmod(temp_dir, 0o777)
        except Exception as e:
            logger.warning(f"Failed to set permissions on temp directory: {str(e)}")

        temp_file_path = os.path.join(temp_dir, f"{uuid.uuid4()}_{filename}")

        # Save the file to the temporary location
        file.save(temp_file_path)

        # Ensure the temporary file has the correct permissions
        try:
            os.chmod(temp_file_path, 0o666)  # Read and write permissions for all users
        except Exception as e:
            logger.warning(f"Failed to set permissions on temporary file: {str(e)}")

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
    return send_from_directory(images_path, decoded_filename)

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

    # Remove the image from the images list
    images_list_file = os.path.join(images_path, 'images_list.json')
    if os.path.exists(images_list_file):
        try:
            with open(images_list_file, 'r') as f:
                images_list = json.load(f)

            # Filter out the deleted image
            if 'images' in images_list:
                images_list['images'] = [img for img in images_list['images'] if img.get('name') != filename]

                # Save the updated list
                with open(images_list_file, 'w') as f:
                    json.dump(images_list, f)
        except Exception as e:
            return jsonify({'error': f'Failed to update images list: {str(e)}'}), 500

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


@app.route('/health')
def health_check():
    """Health check endpoint for Docker"""
    status = {
        'status': 'healthy',
        'redis_client': 'connected' if redis_client and not isinstance(redis_client, DummyRedisClient) else 'disconnected',
        'celery': 'connected' if celery else 'disconnected',
        'socketio': 'connected' if socketio else 'disconnected'
    }
    return jsonify(status)


if __name__ == '__main__':
    # Development server
    # Make sure SocketIO is initialized
    if socketio is None:
        from flask_socketio import SocketIO
        socketio = SocketIO(app, cors_allowed_origins=os.getenv('SOCKETIO_CORS_ALLOWED_ORIGINS', '*'))
        logger.warning("Initialized Socket.IO without Redis message queue support for development server")
    socketio.run(app, debug=True)
# Production server with Gunicorn
# The application is imported by Gunicorn
# Gunicorn will use the 'app' variable as the WSGI application
