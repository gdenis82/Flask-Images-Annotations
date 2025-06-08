document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const imageUpload = document.getElementById('imageUpload');
    const folderUpload = document.getElementById('folderUpload');
    const imageList = document.getElementById('imageList');
    const imageCanvas = document.getElementById('imageCanvas');
    const annotationCanvas = document.getElementById('annotationCanvas');
    const canvasContainer = document.getElementById('canvasContainer');
    const noImageMessage = document.getElementById('noImageMessage');
    const classSelect = document.getElementById('classSelect');
    const polygonTool = document.getElementById('polygonTool');
    const boxTool = document.getElementById('boxTool');
    const confirmExportBtn = document.getElementById('confirmExportBtn');
    const saveProjectSettingsBtn = document.getElementById('saveProjectSettingsBtn');
    const zoomIn = document.getElementById('zoomIn');
    const zoomOut = document.getElementById('zoomOut');
    const zoomReset = document.getElementById('zoomReset');

    // Image management dropdown elements
    const uploadImagesDropdownBtn = document.getElementById('uploadImagesDropdownBtn');
    const uploadFolderDropdownBtn = document.getElementById('uploadFolderDropdownBtn');
    const deleteAllImagesDropdownBtn = document.getElementById('deleteAllImagesDropdownBtn');

    // Navigation buttons
    const prevImageBtn = document.getElementById('prevImageBtn');
    const nextImageBtn = document.getElementById('nextImageBtn');
    const imageCounter = document.getElementById('imageCounter');

    // Canvas contexts
    const ctx = imageCanvas.getContext('2d');
    const annotCtx = annotationCanvas.getContext('2d');

    // State variables
    let currentImage = null;
    let currentImageName = '';
    let currentImageElement = null;
    let scale = 1;
    let annotations = [];
    let currentAnnotation = null;
    let selectedAnnotation = null;
    let isDrawing = false;
    let currentTool = 'polygon'; // Default tool
    let localImages = []; // Array to store local images
    let selectedVertex = null; // For polygon editing
    let isDraggingVertex = false; // For polygon vertex movement
    let projectName = ''; // Project name
    let classColors = {}; // Custom colors for classes

    // Upload queue variables
    let uploadQueue = []; // Queue of files to upload
    let pendingUploads = {}; // Map of task_id to upload info
    let isUploading = false; // Flag to indicate if uploads are in progress
    let maxConcurrentUploads = 3; // Maximum number of concurrent uploads
    let socket = null; // Socket.IO connection

    // Panning variables
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let offsetX = 0;
    let offsetY = 0;

    // Initialize
    init();

    function init() {
        // Load project data first to get class colors
        loadProjectData();

        // Initialize Socket.IO connection
        initSocketConnection();

        // Load any pending uploads from localStorage
        loadPendingUploads();

        // Set up event listeners for image management dropdown
        uploadImagesDropdownBtn.addEventListener('click', () => imageUpload.click());
        imageUpload.addEventListener('change', handleImageUpload);

        uploadFolderDropdownBtn.addEventListener('click', () => folderUpload.click());
        folderUpload.addEventListener('change', handleFolderUpload);

        deleteAllImagesDropdownBtn.addEventListener('click', confirmDeleteAllImages);

        // Set up event listeners for navigation buttons
        prevImageBtn.addEventListener('click', navigateToPreviousImage);
        nextImageBtn.addEventListener('click', navigateToNextImage);

        // Set up event listeners for annotation tools
        polygonTool.addEventListener('click', () => setTool('polygon'));
        boxTool.addEventListener('click', () => setTool('box'));

        confirmExportBtn.addEventListener('click', exportYOLO);
        saveProjectSettingsBtn.addEventListener('click', saveProjectSettings);
        document.getElementById('addClass').addEventListener('click', addClassField);

        zoomIn.addEventListener('click', () => zoom(1.1));
        zoomOut.addEventListener('click', () => zoom(0.9));
        zoomReset.addEventListener('click', resetZoom);

        // Add mouse wheel zoom support
        annotationCanvas.addEventListener('wheel', handleMouseWheel, { passive: false });

        // Canvas event listeners
        // Left-click (button 0): Draw polygons and edit vertices
        // Right-click (button 2): Select annotations
        annotationCanvas.addEventListener('mousedown', handleMouseDown);
        annotationCanvas.addEventListener('mousemove', handleMouseMove);
        annotationCanvas.addEventListener('mouseup', handleMouseUp);

        // Prevent context menu on canvas when right-clicking for selection
        annotationCanvas.addEventListener('contextmenu', e => e.preventDefault());

        // Add keyboard event listener for Delete key to remove vertices
        document.addEventListener('keydown', handleKeyDown);

        // Load saved images from server
        // This is the only method we use to load images now, as it handles both
        // loading the image list and loading the actual image data
        loadSavedImages();
    }

    // Function to load project data and update class colors
    function loadProjectData() {
        fetch(`/projects/${projectId}`)
            .then(response => response.json())
            .then(data => {
                // Store project name
                projectName = data.name;

                // Store class colors if available
                if (data.classColors) {
                    classColors = data.classColors;
                }
            })
            .catch(error => {
                console.error('Error loading project data:', error);
            });
    }

    // Function to initialize Socket.IO connection
    function initSocketConnection() {
        // Connect to Socket.IO server
        socket = io();

        // Listen for upload completed events
        socket.on('upload_completed', function(data) {
            console.log('Upload completed:', data);

            // Update the pending upload status
            if (pendingUploads[data.task_id]) {
                pendingUploads[data.task_id].status = 'completed';
                pendingUploads[data.task_id].progress = 100;
                pendingUploads[data.task_id].image_info = data.image_info;

                // Update the UI to show the completed upload
                updateUploadProgress(data.task_id, 100, 'completed');

                // Add the image to the list
                if (data.image_info) {
                    addImageToList(data.image_info);
                }

                // Remove from pending uploads after a delay
                setTimeout(() => {
                    delete pendingUploads[data.task_id];
                    savePendingUploads();

                    // Remove progress indicator
                    const progressElement = document.getElementById(`upload-progress-${data.task_id}`);
                    if (progressElement) {
                        progressElement.remove();
                    }
                }, 3000);
            }

            // Process next item in queue
            processUploadQueue();
        });

        // Listen for upload failed events
        socket.on('upload_failed', function(data) {
            console.error('Upload failed:', data);

            // Update the pending upload status
            if (pendingUploads[data.task_id]) {
                pendingUploads[data.task_id].status = 'failed';
                pendingUploads[data.task_id].error = data.error;

                // Update the UI to show the failed upload
                updateUploadProgress(data.task_id, 0, 'failed', data.error);

                // Remove from pending uploads after a delay
                setTimeout(() => {
                    delete pendingUploads[data.task_id];
                    savePendingUploads();
                }, 5000);
            }

            // Process next item in queue
            processUploadQueue();
        });
    }

    // Function to load pending uploads from localStorage
    function loadPendingUploads() {
        try {
            const savedUploads = localStorage.getItem(`pendingUploads_${projectId}`);
            if (savedUploads) {
                pendingUploads = JSON.parse(savedUploads);

                // Check status of each pending upload
                Object.keys(pendingUploads).forEach(taskId => {
                    checkUploadStatus(taskId);
                });
            }
        } catch (error) {
            console.error('Error loading pending uploads:', error);
        }
    }

    // Function to save pending uploads to localStorage
    function savePendingUploads() {
        try {
            localStorage.setItem(`pendingUploads_${projectId}`, JSON.stringify(pendingUploads));
        } catch (error) {
            console.error('Error saving pending uploads:', error);
        }
    }

    // Function to check the status of an upload
    function checkUploadStatus(taskId) {
        fetch(`/projects/${projectId}/upload/status/${taskId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to get upload status');
                }
                return response.json();
            })
            .then(data => {
                // Update the pending upload status
                if (pendingUploads[taskId]) {
                    pendingUploads[taskId].status = data.status;
                    pendingUploads[taskId].progress = parseInt(data.progress);

                    // Update the UI to show the current status
                    updateUploadProgress(taskId, data.progress, data.status, data.error);

                    // If completed, add the image to the list
                    if (data.status === 'completed' && data.image_info) {
                        addImageToList(data.image_info);

                        // Remove from pending uploads after a delay
                        setTimeout(() => {
                            delete pendingUploads[taskId];
                            savePendingUploads();

                            // Remove progress indicator
                            const progressElement = document.getElementById(`upload-progress-${taskId}`);
                            if (progressElement) {
                                progressElement.remove();
                            }
                        }, 3000);
                    }

                    // If still in progress, check again after a delay
                    if (data.status === 'processing' || data.status === 'queued') {
                        setTimeout(() => checkUploadStatus(taskId), 2000);
                    }
                }
            })
            .catch(error => {
                console.error('Error checking upload status:', error);

                // If we can't get the status, assume it failed
                if (pendingUploads[taskId]) {
                    pendingUploads[taskId].status = 'failed';
                    pendingUploads[taskId].error = 'Failed to get upload status';

                    // Update the UI to show the failed upload
                    updateUploadProgress(taskId, 0, 'failed', 'Failed to get upload status');

                    // Remove from pending uploads after a delay
                    setTimeout(() => {
                        delete pendingUploads[taskId];
                        savePendingUploads();
                    }, 5000);
                }
            });
    }

    // Function to update the upload progress in the UI
    function updateUploadProgress(taskId, progress, status, error) {
        // Find or create progress element
        let progressElement = document.getElementById(`upload-progress-${taskId}`);

        if (!progressElement) {
            // Create a new progress element
            progressElement = document.createElement('div');
            progressElement.id = `upload-progress-${taskId}`;
            progressElement.className = 'alert alert-info upload-progress';
            imageList.prepend(progressElement);
        }

        // Update the progress element based on status
        if (status === 'completed') {
            progressElement.className = 'alert alert-success upload-progress';
            progressElement.innerHTML = `Upload completed: ${pendingUploads[taskId].filename}`;
        } else if (status === 'failed') {
            progressElement.className = 'alert alert-danger upload-progress';
            progressElement.innerHTML = `Upload failed: ${pendingUploads[taskId].filename}<br>${error || ''}`;
        } else {
            progressElement.className = 'alert alert-info upload-progress';
            progressElement.innerHTML = `
                <div>${status === 'queued' ? 'Queued' : 'Uploading'}: ${pendingUploads[taskId].filename}</div>
                <div class="progress mt-2">
                    <div class="progress-bar" role="progressbar" style="width: ${progress}%" 
                         aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100">
                        ${progress}%
                    </div>
                </div>
            `;
        }
    }

    // Function to add an image to the list
    function addImageToList(imageInfo) {
        // Check if image already exists in localImages
        const existingIndex = localImages.findIndex(img => img.name === imageInfo.name);

        if (existingIndex !== -1) {
            // Update existing image
            localImages[existingIndex] = {
                name: imageInfo.name,
                element: localImages[existingIndex].element,
                path: imageInfo.path,
                thumbnail: imageInfo.thumbnail
            };
        } else {
            // Create image object
            const img = new Image();

            // Set the source to the thumbnail for preview
            if (imageInfo.thumbnail) {
                img.src = imageInfo.thumbnail;
            } else {
                // If no thumbnail, try to load from the server path
                const normalizedImageName = imageInfo.name.replace(/\\/g, '/');
                img.src = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`;
            }

            img.onload = function() {
                // Add to local images array
                localImages.push({
                    name: imageInfo.name,
                    element: img,
                    path: imageInfo.path,
                    thumbnail: imageInfo.thumbnail
                });

                // Create image item in the list with preview
                createImageListItem(imageInfo.name, imageInfo.thumbnail);

                // Load the first image if none is loaded
                if (!currentImage && localImages.length === 1) {
                    loadLocalImage(imageInfo.name);
                }

                // Update the image counter
                updateImageCounter();
            };

            img.onerror = function() {
                console.error('Failed to load image:', imageInfo.name);
            };
        }
    }

    // This function is no longer used - we use loadSavedImages instead
    // Keeping this comment for documentation purposes

    // Function to load saved images from server
    function loadSavedImages() {
        // Initialize the image counter to "Image 0 of 0"
        updateImageCounter();

        // Get saved images for this project from the server
        fetch(`/projects/${projectId}/images`)
            .then(response => response.json())
            .then(data => {
                if (data && data.images && data.images.length > 0) {
                    // Always clear the image list to prevent duplication
                    imageList.innerHTML = '';
                    // Reset localImages array to prevent duplication
                    localImages = [];

                    // Load each saved image
                    data.images.forEach(savedImage => {
                        // If we have a path, use it to load the image
                        if (savedImage.path) {
                            // Create image object
                            const img = new Image();

                            // For security reasons, browsers don't allow direct access to local file paths
                            // In a real application, you would need to use a file system API or server-side solution
                            // For this demo, we'll use the thumbnail for display
                            img.src = savedImage.thumbnail || '';

                            img.onload = function() {
                                // Add to local images array
                                localImages.push({
                                    name: savedImage.name,
                                    element: img,
                                    path: savedImage.path,
                                    thumbnail: savedImage.thumbnail
                                });

                                // Create image item in the list with preview
                                createImageListItem(savedImage.name, savedImage.thumbnail);

                                // Load the first image if none is loaded
                                if (!currentImage && localImages.length === 1) {
                                    loadLocalImage(savedImage.name);
                                }
                            };

                            // If image fails to load from path, use the thumbnail
                            img.onerror = function() {
                                console.warn(`Failed to load image from path: ${savedImage.path}`);
                                if (savedImage.thumbnail) {
                                    img.src = savedImage.thumbnail;
                                }
                            };
                        }
                    });

                    // Load the last active image if any
                    if (data.lastActiveImage) {
                        // We'll load this after a short delay to ensure images are loaded
                        setTimeout(() => {
                            loadLocalImage(data.lastActiveImage);
                        }, 500);
                    }
                }
            })
            .catch(error => {
                console.error('Error loading saved images:', error);
            });
    }

    // Function to save images to server
    function saveImagesToServer() {
        // Only save the last active image information
        const dataToSave = {
            images: localImages.map(img => ({
                name: img.name,
                path: img.path || '',
                thumbnail: img.thumbnail || ''
            })),
            lastActiveImage: currentImageName
        };

        // Save to server
        fetch(`/projects/${projectId}/images`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dataToSave)
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to save images');
            }
            return response.json();
        })
        .catch(error => {
            console.error('Error saving images to server:', error);
            alert('Failed to save images. Please try again.');
        });
    }

    // Function to create an image list item with preview
    function createImageListItem(imageName, imageData) {
        // Create image item container
        const imageItem = document.createElement('div');
        imageItem.className = 'image-item';
        imageItem.dataset.name = imageName;
        imageItem.title = imageName; // Add tooltip on hover

        // Create preview thumbnail
        const thumbnail = document.createElement('img');
        thumbnail.src = imageData;
        thumbnail.className = 'image-thumbnail';
        thumbnail.alt = imageName;

        // Create image name element
        const nameSpan = document.createElement('span');
        nameSpan.textContent = imageName;
        nameSpan.className = 'image-name';

        // Create delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-sm btn-danger delete-image-btn';
        deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
        deleteBtn.title = 'Delete image';

        // Prevent the click event from bubbling up to the parent
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete the image "${imageName}"?`)) {
                deleteImage(imageName);
            }
        });

        // Add elements to container
        imageItem.appendChild(thumbnail);
        imageItem.appendChild(nameSpan);
        imageItem.appendChild(deleteBtn);

        // Add click event for selecting the image
        imageItem.addEventListener('click', () => loadLocalImage(imageName));

        // Add to image list
        imageList.appendChild(imageItem);

        return imageItem;
    }

    // Function to delete an image
    function deleteImage(imageName) {
        // Convert Windows backslashes to forward slashes for URL
        const normalizedImageName = imageName.replace(/\\/g, '/');

        // Send delete request to server
        fetch(`/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`, {
            method: 'DELETE'
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to delete image');
            }
            return response.json();
        })
        .then(data => {
            if (data.success) {
                // Remove from local images array
                const index = localImages.findIndex(img => img.name === imageName);
                if (index !== -1) {
                    localImages.splice(index, 1);
                }

                // Remove from image list in UI
                const imageItem = document.querySelector(`.image-item[data-name="${imageName}"]`);
                if (imageItem) {
                    imageItem.remove();
                }

                // If this was the current image, clear it
                if (currentImageName === imageName) {
                    currentImage = null;
                    currentImageName = '';
                    currentImageElement = null;

                    // Clear canvas
                    annotCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
                    ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

                    // Show no image message
                    noImageMessage.style.display = 'block';
                    canvasContainer.style.display = 'none';

                    // Clear annotations
                    annotations = [];
                    updateAnnotationsList();
                }

                // If there are other images, load the first one
                else if (localImages.length > 0) {
                    loadLocalImage(localImages[0].name);
                }

                // Save updated images list to server
                saveImagesToServer();

                // Update the image counter display
                updateImageCounter();

                alert('Image deleted successfully');
            } else {
                alert('Failed to delete image: ' + (data.message || 'Unknown error'));
            }
        })
        .catch(error => {
            console.error('Error deleting image:', error);
            alert('Failed to delete image. Please try again.');
        });
    }

    // Function to handle image upload
    function handleImageUpload(event) {
        const files = event.target.files;
        if (files.length === 0) return;

        // Clear the image list if it's showing the default message
        if (imageList.querySelector('.alert:not(.upload-progress)')) {
            imageList.querySelector('.alert:not(.upload-progress)').remove();
        }

        // Add files to the upload queue
        addFilesToUploadQueue(files);
    }

    // Function to handle folder upload
    function handleFolderUpload(event) {
        const files = event.target.files;
        if (files.length === 0) return;

        // Clear the image list if it's showing the default message
        if (imageList.querySelector('.alert:not(.upload-progress)')) {
            imageList.querySelector('.alert:not(.upload-progress)').remove();
        }

        // Filter for image files only
        const imageFiles = Array.from(files).filter(file => 
            file.type.startsWith('image/') || 
            /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file.name)
        );

        if (imageFiles.length === 0) {
            alert('No image files found in the selected folder.');
            return;
        }

        // Add files to the upload queue
        addFilesToUploadQueue(imageFiles);
    }

    // Function to add files to the upload queue
    function addFilesToUploadQueue(files) {
        // Add each file to the queue
        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // Skip non-image files
            if (!file.type.startsWith('image/') && 
                !/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file.name)) {
                continue;
            }

            // Add to queue
            uploadQueue.push(file);
        }

        // Show queue status
        const queueStatusElement = document.getElementById('upload-queue-status');
        if (!queueStatusElement) {
            const statusElement = document.createElement('div');
            statusElement.id = 'upload-queue-status';
            statusElement.className = 'alert alert-info';
            statusElement.innerHTML = `Queued ${uploadQueue.length} files for upload`;
            imageList.prepend(statusElement);
        } else {
            queueStatusElement.innerHTML = `Queued ${uploadQueue.length} files for upload`;
        }

        // Start processing the queue if not already processing
        if (!isUploading) {
            processUploadQueue();
        }
    }

    // Function to process the upload queue
    function processUploadQueue() {
        // If no files in queue or already at max concurrent uploads, return
        if (uploadQueue.length === 0) {
            isUploading = false;

            // Remove queue status element if queue is empty
            const queueStatusElement = document.getElementById('upload-queue-status');
            if (queueStatusElement) {
                queueStatusElement.remove();
            }

            return;
        }

        // Count current active uploads
        const activeUploads = Object.values(pendingUploads).filter(
            upload => upload.status === 'queued' || upload.status === 'processing'
        ).length;

        // If at max concurrent uploads, wait and try again later
        if (activeUploads >= maxConcurrentUploads) {
            isUploading = true;
            setTimeout(processUploadQueue, 1000);
            return;
        }

        // Get next file from queue
        const file = uploadQueue.shift();

        // Update queue status
        const queueStatusElement = document.getElementById('upload-queue-status');
        if (queueStatusElement) {
            queueStatusElement.innerHTML = `Queued ${uploadQueue.length} files for upload`;
        }

        // Upload the file
        uploadFile(file);

        // Set uploading flag
        isUploading = true;

        // Process next file after a short delay
        setTimeout(processUploadQueue, 500);
    }

    // Function to upload a single file
    function uploadFile(file) {
        // Create FormData to send the file to the server
        const formData = new FormData();
        formData.append('file', file);

        // Create a unique ID for this upload (before we get the task ID from the server)
        const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Add to pending uploads with initial status
        pendingUploads[clientId] = {
            filename: file.name,
            status: 'uploading',
            progress: 0,
            created: new Date().toISOString()
        };

        // Update UI with initial progress
        updateUploadProgress(clientId, 0, 'uploading');

        // Save pending uploads to localStorage
        savePendingUploads();

        // Upload the file to the server
        fetch(`/projects/${projectId}/upload`, {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to upload image');
            }
            return response.json();
        })
        .then(data => {
            if (data.success && data.task_id) {
                // Update pending uploads with task ID
                const taskId = data.task_id;

                // Copy client upload info to task ID
                pendingUploads[taskId] = {
                    ...pendingUploads[clientId],
                    status: data.status || 'queued',
                    task_id: taskId
                };

                // Remove client ID entry
                delete pendingUploads[clientId];

                // Update UI with task ID
                const progressElement = document.getElementById(`upload-progress-${clientId}`);
                if (progressElement) {
                    progressElement.id = `upload-progress-${taskId}`;
                    updateUploadProgress(taskId, 0, data.status || 'queued');
                }

                // Save pending uploads to localStorage
                savePendingUploads();

                // Start checking status
                checkUploadStatus(taskId);
            } else {
                // Update status to failed
                pendingUploads[clientId].status = 'failed';
                pendingUploads[clientId].error = data.error || 'Unknown error';

                // Update UI
                updateUploadProgress(clientId, 0, 'failed', data.error || 'Unknown error');

                // Remove from pending uploads after a delay
                setTimeout(() => {
                    delete pendingUploads[clientId];
                    savePendingUploads();
                }, 5000);

                // Process next item in queue
                processUploadQueue();
            }
        })
        .catch(error => {
            console.error('Error uploading image:', error);

            // Update status to failed
            pendingUploads[clientId].status = 'failed';
            pendingUploads[clientId].error = error.message || 'Network error';

            // Update UI
            updateUploadProgress(clientId, 0, 'failed', error.message || 'Network error');

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[clientId];
                savePendingUploads();
            }, 5000);

            // Process next item in queue
            processUploadQueue();
        });
    }

    // Function to confirm and delete all images
    function confirmDeleteAllImages() {
        if (localImages.length === 0) {
            alert('No images to delete.');
            return;
        }

        if (confirm('Are you sure you want to delete ALL images? This action cannot be undone.')) {
            deleteAllImages();
        }
    }

    // Function to delete all images
    function deleteAllImages() {
        // Show deletion progress
        const progressContainer = document.createElement('div');
        progressContainer.className = 'alert alert-warning';
        progressContainer.innerHTML = 'Deleting all images...';
        imageList.innerHTML = '';
        imageList.appendChild(progressContainer);

        // Create a copy of the images array to iterate through
        const imagesToDelete = [...localImages];
        let deletedCount = 0;
        let errorCount = 0;

        // Clear current image display
        currentImage = null;
        currentImageName = '';
        currentImageElement = null;
        annotations = [];

        // Clear canvas
        annotCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
        ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

        // Show no image message
        noImageMessage.style.display = 'block';
        canvasContainer.style.display = 'none';

        // Delete each image
        for (const image of imagesToDelete) {
            // Convert Windows backslashes to forward slashes for URL
            const normalizedImageName = image.name.replace(/\\/g, '/');

            // Send delete request to server
            fetch(`/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`, {
                method: 'DELETE'
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to delete image');
                }
                return response.json();
            })
            .then(data => {
                deletedCount++;

                // Remove from local images array
                const index = localImages.findIndex(img => img.name === image.name);
                if (index !== -1) {
                    localImages.splice(index, 1);
                }

                // Update progress
                progressContainer.innerHTML = `Deleted ${deletedCount}/${imagesToDelete.length} images...`;

                // Check if all images have been processed
                if (deletedCount + errorCount === imagesToDelete.length) {
                    finishDeletion(progressContainer, errorCount);
                }
            })
            .catch(error => {
                deletedCount++;
                errorCount++;
                console.error('Error deleting image:', error);

                // Update progress
                progressContainer.innerHTML = `Deleted ${deletedCount}/${imagesToDelete.length} images (${errorCount} errors)...`;

                // Check if all images have been processed
                if (deletedCount + errorCount === imagesToDelete.length) {
                    finishDeletion(progressContainer, errorCount);
                }
            });
        }
    }

    // Function to finish the deletion process
    function finishDeletion(progressContainer, errorCount) {
        // All images processed
        if (errorCount > 0) {
            progressContainer.className = 'alert alert-danger';
            progressContainer.innerHTML = `Deletion completed with ${errorCount} errors.`;
        } else {
            progressContainer.className = 'alert alert-success';
            progressContainer.innerHTML = 'All images deleted successfully.';
        }

        // Clear local images array
        localImages = [];

        // Save empty images list to server
        saveImagesToServer();

        // Update the image counter display
        updateImageCounter();

        // After a delay, show the default message
        setTimeout(() => {
            imageList.innerHTML = '<div class="alert alert-info">No images added yet. Click "Add Images" to get started.</div>';
        }, 3000);
    }

    // Function to load a local image
    function loadLocalImage(imageName) {
        const imageData = localImages.find(img => img.name === imageName);
        if (!imageData) return;

        // Update current image name and element
        currentImageName = imageName;
        currentImageElement = imageData;

        // Create a new image object to load from server
        const img = new Image();

        // Convert Windows backslashes to forward slashes for URL
        const normalizedImageName = imageName.replace(/\\/g, '/');

        // Try to load from server using URL format (forward slashes)
        img.src = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`;

        img.onload = function() {
            // Update current image with the loaded image
            currentImage = img;

            // Display the image
            displayImage();

            // Load annotations for this image if any
            loadAnnotations(imageName);
        };

        img.onerror = function() {
            console.error('Failed to load image from server:', imageName);

            // Try an alternative approach with a timestamp to avoid caching issues
            const timestamp = new Date().getTime();
            img.src = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}?t=${timestamp}`;

            img.onload = function() {
                // Update current image with the loaded image
                currentImage = img;
                displayImage();
                loadAnnotations(imageName);
            };

            img.onerror = function() {
                console.error('Second attempt failed to load image from server:', imageName);

                // Fallback to thumbnail if available
                if (imageData.thumbnail) {
                    const thumbImg = new Image();
                    thumbImg.src = imageData.thumbnail;

                    thumbImg.onload = function() {
                        currentImage = thumbImg;
                        displayImage();
                        loadAnnotations(imageName);
                    };
                } else {
                    alert('Failed to load image: ' + imageName);
                }
            };
        };

        // Update active class in image list
        const imageItems = document.querySelectorAll('.image-item');
        imageItems.forEach(item => {
            item.classList.remove('active');
            if (item.dataset.name === imageName) {
                item.classList.add('active');
            }
        });

        // Save current image to server
        if (currentImageName) {
            saveImagesToServer();
        }

        // Update the image counter display
        updateImageCounter();
    }

    // Function to handle mouse wheel for zooming
    function handleMouseWheel(e) {
        e.preventDefault(); // Prevent page scrolling

        if (!currentImage) return;

        // Determine zoom direction
        const delta = Math.sign(e.deltaY);

        // Zoom in or out based on wheel direction
        if (delta < 0) {
            // Zoom in
            zoom(1.1);
        } else {
            // Zoom out
            zoom(0.9);
        }
    }

    // Function to handle keyboard events
    // Since right-click is now used for selection, we use keyboard for vertex deletion
    function handleKeyDown(e) {
        // ESC key to clear selection
        if (e.key === 'Escape') {
            // Clear selection
            selectedAnnotation = null;
            selectedVertex = null;
            isDraggingVertex = false;
            drawAnnotations();
            return;
        }

        // Delete or Backspace key to remove selected vertex or annotation
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedAnnotation) {
                // If a polygon vertex is selected, delete the vertex
                if (selectedAnnotation.type === 'polygon' && selectedVertex !== null) {
                    // Only delete if we have more than 3 points (minimum for a polygon)
                    if (selectedAnnotation.points.length > 3) {
                        // Remove the vertex
                        selectedAnnotation.points.splice(selectedVertex, 1);

                        // Reset vertex selection state
                        selectedVertex = null;
                        isDraggingVertex = false;

                        // Update the display
                        drawAnnotations();

                        // Save annotations after editing
                        saveAnnotations();
                    } else {
                        // Provide feedback if polygon would be invalid
                        console.warn('Cannot delete vertex: polygon must have at least 3 points');
                    }
                } 
                // If no vertex is selected but an annotation is selected, delete the entire annotation
                else {
                    deleteSelectedAnnotation();
                }
            }
        }
    }

    // Function to load an image from the server - no longer used
    // We now use loadLocalImage for all image loading

    // Function to display the current image
    function displayImage() {
        if (!currentImage) {
            noImageMessage.style.display = 'block';
            canvasContainer.style.display = 'none';
            return;
        }

        noImageMessage.style.display = 'none';
        canvasContainer.style.display = 'block';

        // Set canvas dimensions to match image
        const containerWidth = canvasContainer.parentElement.clientWidth;
        const containerHeight = canvasContainer.parentElement.clientHeight;

        // Only calculate initial scale if it hasn't been set by zoom
        if (scale === 1) {
            // Calculate scale to fit image in container while maintaining aspect ratio
            const scaleX = containerWidth / currentImage.width;
            const scaleY = containerHeight / currentImage.height;
            scale = Math.min(scaleX, scaleY, 1); // Don't scale up images that are smaller than the container
        }

        // Set canvas dimensions based on current scale
        const scaledWidth = currentImage.width * scale;
        const scaledHeight = currentImage.height * scale;

        imageCanvas.width = scaledWidth;
        imageCanvas.height = scaledHeight;
        annotationCanvas.width = scaledWidth;
        annotationCanvas.height = scaledHeight;

        // Center canvas in container and apply offset for panning
        canvasContainer.style.width = `${scaledWidth}px`;
        canvasContainer.style.height = `${scaledHeight}px`;
        canvasContainer.style.transform = `translate(${offsetX}px, ${offsetY}px)`;

        // Draw image
        ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
        ctx.drawImage(currentImage, 0, 0, scaledWidth, scaledHeight);

        // Draw annotations
        drawAnnotations();
    }

    // Function to set the current tool
    function setTool(tool) {
        currentTool = tool;

        // Update UI
        polygonTool.classList.toggle('active', tool === 'polygon');
        boxTool.classList.toggle('active', tool === 'box');

        // Reset current annotation if switching tools
        if (isDrawing) {
            isDrawing = false;
            currentAnnotation = null;
            drawAnnotations();
        }
    }

    // Function to find the nearest vertex in a polygon
    function findNearestVertex(annotation, x, y) {
        if (annotation.type !== 'polygon') return null;

        let minDistance = Infinity;
        let nearestIndex = -1;

        annotation.points.forEach((point, index) => {
            const dx = point[0] - x;
            const dy = point[1] - y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < minDistance) {
                minDistance = distance;
                nearestIndex = index;
            }
        });

        // Only return if the vertex is close enough (within 10 pixels, adjusted for scale)
        // When zoomed in, we need a smaller threshold; when zoomed out, we need a larger threshold
        const threshold = 10 / scale;
        return minDistance < threshold ? { index: nearestIndex, distance: minDistance } : null;
    }

    // Function to find the nearest edge in a polygon
    function findNearestEdge(annotation, x, y) {
        if (annotation.type !== 'polygon') return null;

        let minDistance = Infinity;
        let nearestEdge = -1;
        let nearestPoint = null;

        for (let i = 0; i < annotation.points.length; i++) {
            const p1 = annotation.points[i];
            const p2 = annotation.points[(i + 1) % annotation.points.length]; // Wrap around to first point

            // Calculate distance from point to line segment
            const distance = distanceToLineSegment(x, y, p1[0], p1[1], p2[0], p2[1]);

            if (distance.distance < minDistance) {
                minDistance = distance.distance;
                nearestEdge = i;
                nearestPoint = distance.point;
            }
        }

        // Only return if the edge is close enough (within 5 pixels, adjusted for scale)
        // When zoomed in, we need a smaller threshold; when zoomed out, we need a larger threshold
        const threshold = 5 / scale;
        return minDistance < threshold ? { edge: nearestEdge, point: nearestPoint, distance: minDistance } : null;
    }

    // Function to calculate distance from point to line segment
    function distanceToLineSegment(x, y, x1, y1, x2, y2) {
        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const len_sq = C * C + D * D;
        let param = -1;

        if (len_sq !== 0) param = dot / len_sq;

        let xx, yy;

        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }

        const dx = x - xx;
        const dy = y - yy;

        return { 
            distance: Math.sqrt(dx * dx + dy * dy),
            point: [xx, yy]
        };
    }

    // Function to handle mouse down on canvas
    function handleMouseDown(e) {
        if (!currentImage) return;

        const rect = annotationCanvas.getBoundingClientRect();
        const canvasX = (e.clientX - rect.left);
        const canvasY = (e.clientY - rect.top);

        // Transform from scaled canvas coordinates to original image coordinates
        const transformed = inverseTransformCoord(canvasX, canvasY);
        const x = transformed.x;
        const y = transformed.y;

        // Right-click for selecting polygons, canceling polygon creation, or panning when zoomed
        if (e.button === 2) {
            e.preventDefault(); // Prevent context menu

            // If we're in the middle of drawing a polygon, handle right-click to cancel or complete
            if (isDrawing && currentAnnotation && currentAnnotation.type === 'polygon') {
                // If we have at least 3 points, complete the polygon
                if (currentAnnotation.points.length >= 3) {
                    annotations.push(currentAnnotation);
                    currentAnnotation = null;
                    isDrawing = false;

                    // Auto-save annotations when polygon is completed
                    saveAnnotations();
                    drawAnnotations();
                    return;
                } else {
                    // If we have fewer than 3 points, cancel the polygon
                    currentAnnotation = null;
                    isDrawing = false;
                    drawAnnotations();
                    console.warn('Polygon canceled: must have at least 3 points');
                    return;
                }
            }

            // Check if we're right-clicking on a vertex of a selected polygon to delete it
            if (selectedAnnotation && selectedAnnotation.type === 'polygon') {
                const nearestVertex = findNearestVertex(selectedAnnotation, x, y);

                if (nearestVertex) {
                    // Only delete if we have more than 3 points (minimum for a polygon)
                    if (selectedAnnotation.points.length > 3) {
                        // Remove the vertex
                        selectedAnnotation.points.splice(nearestVertex.index, 1);

                        // Reset vertex selection state
                        selectedVertex = null;
                        isDraggingVertex = false;

                        // Update the display
                        drawAnnotations();

                        // Save annotations after editing
                        saveAnnotations();
                        return;
                    } else {
                        console.warn('Cannot delete vertex: polygon must have at least 3 points');
                    }
                }
            }

            // Check if we're clicking on an existing annotation
            const clickedAnnotation = findAnnotationAtPoint(x, y);

            if (clickedAnnotation) {
                // Select annotation
                selectedAnnotation = clickedAnnotation;
                selectedVertex = null;
                isDraggingVertex = false;
                drawAnnotations();
                return;
            }

            // Always clear selection when right-clicking on empty space
            selectedAnnotation = null;
            selectedVertex = null;
            isDraggingVertex = false;
            drawAnnotations();

            // If we're zoomed in, start panning
            if (scale > 1) {
                isPanning = true;
                panStartX = e.clientX;
                panStartY = e.clientY;
            }
            return;
        }

        // Left-click for drawing and editing
        if (e.button === 0) {
            // Check if clicked on a vertex of the selected polygon
            if (selectedAnnotation && selectedAnnotation.type === 'polygon') {
                const nearestVertex = findNearestVertex(selectedAnnotation, x, y);

                if (nearestVertex) {
                    // Start dragging this vertex
                    selectedVertex = nearestVertex.index;
                    isDraggingVertex = true;
                    drawAnnotations();
                    return;
                }

                // Check if clicked on an edge of the selected polygon
                const nearestEdge = findNearestEdge(selectedAnnotation, x, y);

                if (nearestEdge) {
                    // Add a new vertex at this point
                    selectedAnnotation.points.splice(
                        nearestEdge.edge + 1, 
                        0, 
                        [nearestEdge.point[0], nearestEdge.point[1]]
                    );

                    // Select and start dragging the new vertex
                    selectedVertex = nearestEdge.edge + 1;
                    isDraggingVertex = true;
                    drawAnnotations();
                    return;
                }
            }

            // Check if we're clicking on an existing annotation
            const clickedAnnotation = findAnnotationAtPoint(x, y);

            if (clickedAnnotation) {
                // Select annotation
                selectedAnnotation = clickedAnnotation;
                selectedVertex = null;
                isDraggingVertex = false;
                drawAnnotations();
                return;
            } else {
                // Deselect if left-clicked elsewhere
                selectedAnnotation = null;
                selectedVertex = null;
                isDraggingVertex = false;
                drawAnnotations();
            }

            // Start new annotation
            isDrawing = true;

            if (currentTool === 'polygon') {
                if (!currentAnnotation) {
                    // Start new polygon
                    currentAnnotation = {
                        type: 'polygon',
                        class: parseInt(classSelect.value),
                        points: [[x, y]]
                    };
                } else {
                    // Add point to existing polygon
                    currentAnnotation.points.push([x, y]);

                    // No auto-completion when clicking near first point
                    // Polygon is completed only with right-click (see right-click handler)
                }
            } else if (currentTool === 'box') {
                // Start new box
                currentAnnotation = {
                    type: 'box',
                    class: parseInt(classSelect.value),
                    startX: x,
                    startY: y,
                    width: 0,
                    height: 0
                };
            }

            drawAnnotations();
        }
    }

    // Function to handle mouse move on canvas
    function handleMouseMove(e) {
        // Handle panning with right mouse button
        if (isPanning) {
            const deltaX = e.clientX - panStartX;
            const deltaY = e.clientY - panStartY;

            // Update offset values
            offsetX += deltaX;
            offsetY += deltaY;

            // Update pan start position
            panStartX = e.clientX;
            panStartY = e.clientY;

            // Apply the new offset to the canvas container
            canvasContainer.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
            return;
        }

        const rect = annotationCanvas.getBoundingClientRect();
        const canvasX = (e.clientX - rect.left);
        const canvasY = (e.clientY - rect.top);

        // Transform from scaled canvas coordinates to original image coordinates
        const transformed = inverseTransformCoord(canvasX, canvasY);
        const x = transformed.x;
        const y = transformed.y;

        // Handle vertex dragging
        if (isDraggingVertex && selectedAnnotation && selectedVertex !== null) {
            // Update the vertex position
            selectedAnnotation.points[selectedVertex] = [x, y];
            drawAnnotations();
            return;
        }

        // Handle drawing new annotation
        if (isDrawing && currentAnnotation) {
            if (currentTool === 'box') {
                // Update box dimensions
                currentAnnotation.width = x - currentAnnotation.startX;
                currentAnnotation.height = y - currentAnnotation.startY;
            }

            drawAnnotations();
        }
    }

    // Function to handle mouse up on canvas
    function handleMouseUp(e) {
        // End panning
        if (isPanning) {
            isPanning = false;
            return;
        }

        // Handle vertex dragging end
        if (isDraggingVertex && selectedAnnotation) {
            isDraggingVertex = false;
            // Save annotations after editing
            saveAnnotations();
            return;
        }

        // Handle drawing completion
        if (isDrawing && currentAnnotation) {
            if (currentTool === 'box') {
                // Complete box if it's large enough (avoid tiny accidental boxes)
                if (Math.abs(currentAnnotation.width) > 5 && Math.abs(currentAnnotation.height) > 5) {
                    // Normalize box coordinates (handle negative width/height)
                    if (currentAnnotation.width < 0) {
                        currentAnnotation.startX += currentAnnotation.width;
                        currentAnnotation.width = Math.abs(currentAnnotation.width);
                    }

                    if (currentAnnotation.height < 0) {
                        currentAnnotation.startY += currentAnnotation.height;
                        currentAnnotation.height = Math.abs(currentAnnotation.height);
                    }

                    // Add to annotations array
                    annotations.push(currentAnnotation);

                    // Auto-save annotations when box is completed
                    saveAnnotations();
                } else {
                    console.log('Box too small, ignoring');
                }

                // Reset drawing state
                currentAnnotation = null;
                isDrawing = false;

                // Update display
                drawAnnotations();
            }
        }
    }

    // Function to find annotation at point
    function findAnnotationAtPoint(x, y) {
        // Check in reverse order (top annotations first)
        for (let i = annotations.length - 1; i >= 0; i--) {
            const annotation = annotations[i];

            if (annotation.type === 'box') {
                // Check if point is inside box
                if (x >= annotation.startX && x <= annotation.startX + annotation.width &&
                    y >= annotation.startY && y <= annotation.startY + annotation.height) {
                    return annotation;
                }
            } else if (annotation.type === 'polygon') {
                // Check if point is inside polygon
                if (isPointInPolygon(x, y, annotation.points)) {
                    return annotation;
                }
            }
        }

        return null;
    }

    // Function to check if point is inside polygon
    function isPointInPolygon(x, y, points) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const xi = points[i][0], yi = points[i][1];
            const xj = points[j][0], yj = points[j][1];

            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }

        return inside;
    }

    // Function to transform coordinates from original to scaled
    function transformCoord(x, y) {
        // The annotations are stored in the original image coordinates
        // We need to transform them to the scaled canvas coordinates
        return {
            x: x * scale,
            y: y * scale
        };
    }

    // Function to transform coordinates from scaled to original
    function inverseTransformCoord(x, y) {
        // Convert from scaled canvas coordinates to original image coordinates
        return {
            x: x / scale,
            y: y / scale
        };
    }

    // Function to update the annotations list in the sidebar
    function updateAnnotationsList() {
        const annotationsList = document.getElementById('annotationsList');

        // Clear the list
        annotationsList.innerHTML = '';

        if (annotations.length === 0) {
            // Show "no annotations" message
            annotationsList.innerHTML = '<div class="alert alert-info">No annotations yet.</div>';
            return;
        }

        // Create an item for each annotation
        annotations.forEach((annotation, index) => {
            const item = document.createElement('div');
            item.className = 'annotation-item';
            if (annotation === selectedAnnotation) {
                item.classList.add('active');
            }

            // Add type badge
            const typeBadge = document.createElement('span');
            typeBadge.className = `annotation-type ${annotation.type}`;
            typeBadge.textContent = annotation.type.charAt(0).toUpperCase() + annotation.type.slice(1);

            // Add color indicator with color picker functionality
            const colorIndicator = document.createElement('span');
            colorIndicator.className = 'annotation-color';
            colorIndicator.title = 'Click to change color';
            const classIndex = annotation.class % projectClasses.length;
            colorIndicator.style.backgroundColor = getColorForClass(classIndex);

            // Make color indicator clickable to show color picker
            colorIndicator.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent item selection
                showColorPicker(e, classIndex, colorIndicator);
            });

            // Add class name with dropdown functionality
            const classNameContainer = document.createElement('div');
            classNameContainer.className = 'annotation-class-container';

            const className = document.createElement('span');
            className.className = 'annotation-class';
            className.textContent = projectClasses[classIndex];
            className.title = 'Click to change class';

            // Make class name clickable to show class dropdown
            className.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent item selection
                showClassDropdown(e, annotation, classIndex, className);
            });

            classNameContainer.appendChild(className);

            // Add delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-sm btn-danger delete-annotation-btn';
            deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
            deleteBtn.title = 'Delete annotation';

            // Prevent the click event from bubbling up to the parent
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Set this annotation as the selected one
                selectedAnnotation = annotation;
                // Delete it
                deleteSelectedAnnotation();
            });

            // Add elements to item
            item.appendChild(typeBadge);
            item.appendChild(colorIndicator);
            item.appendChild(classNameContainer);
            item.appendChild(deleteBtn);

            // Add click event to select the annotation
            item.addEventListener('click', () => {
                selectedAnnotation = annotation;
                selectedVertex = null;
                isDraggingVertex = false;
                drawAnnotations();
            });

            annotationsList.appendChild(item);
        });
    }

    // Function to show color picker for a class
    function showColorPicker(event, classIndex, colorIndicator) {
        // Create a custom color picker container
        const colorPickerContainer = document.createElement('div');
        colorPickerContainer.className = 'custom-color-picker';

        // Position it to the right of the color indicator
        const rect = colorIndicator.getBoundingClientRect();
        colorPickerContainer.style.left = `${rect.right + 10}px`;
        colorPickerContainer.style.top = `${rect.top}px`;

        // Create color picker input
        const colorPicker = document.createElement('input');
        colorPicker.type = 'color';
        colorPicker.value = getColorForClass(classIndex);

        // Add elements to container
        colorPickerContainer.appendChild(colorPicker);

        // Add container to body
        document.body.appendChild(colorPickerContainer);

        // Handle color change immediately
        colorPicker.addEventListener('input', () => {
            const newColor = colorPicker.value;

            // Update color in UI
            colorIndicator.style.backgroundColor = newColor;
        });

        // Apply color change when the color picker is closed
        colorPicker.addEventListener('change', () => {
            const newColor = colorPicker.value;

            // Update color in project settings
            updateClassColor(classIndex, newColor);

            // Remove the color picker
            document.body.removeChild(colorPickerContainer);
            document.removeEventListener('click', closeColorPicker);
        });

        // Close color picker when clicking outside
        const closeColorPicker = (e) => {
            if (!colorPickerContainer.contains(e.target) && e.target !== colorIndicator) {
                document.body.removeChild(colorPickerContainer);
                document.removeEventListener('click', closeColorPicker);
            }
        };

        // Add a small delay to prevent immediate closing
        setTimeout(() => {
            document.addEventListener('click', closeColorPicker);
        }, 100);
    }

    // Function to update class color in project settings
    function updateClassColor(classIndex, newColor) {
        // Update local classColors object
        classColors[classIndex] = newColor;

        // Get current project settings
        fetch(`/projects/${projectId}`)
            .then(response => response.json())
            .then(data => {
                // Update class colors in project settings
                const updatedSettings = {
                    name: data.name,
                    classes: data.classes,
                    classColors: { ...data.classColors, [classIndex]: newColor }
                };

                // Save updated settings to server
                return fetch(`/projects/${projectId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(updatedSettings)
                });
            })
            .then(response => response.json())
            .then(data => {
                // Redraw annotations with new colors
                drawAnnotations();
            })
            .catch(error => {
                console.error('Error updating class color:', error);
                alert('Failed to update class color. Please try again.');
            });
    }

    // Function to show class dropdown for an annotation
    function showClassDropdown(event, annotation, currentClassIndex, classNameElement) {
        // Create dropdown container
        const dropdown = document.createElement('div');
        dropdown.className = 'class-dropdown';
        dropdown.style.position = 'absolute';
        dropdown.style.left = `${event.clientX}px`;
        dropdown.style.top = `${event.clientY}px`;
        dropdown.style.backgroundColor = '#fff';
        dropdown.style.border = '1px solid #ccc';
        dropdown.style.borderRadius = '4px';
        dropdown.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
        dropdown.style.zIndex = '1000';
        dropdown.style.maxHeight = '200px';
        dropdown.style.overflowY = 'auto';

        // Add class options
        projectClasses.forEach((className, index) => {
            const option = document.createElement('div');
            option.className = 'class-option';
            option.textContent = className;
            option.style.padding = '8px 12px';
            option.style.cursor = 'pointer';

            // Highlight current class
            if (index === currentClassIndex) {
                option.style.backgroundColor = '#e9ecef';
                option.style.fontWeight = 'bold';
            }

            // Hover effect
            option.addEventListener('mouseover', () => {
                option.style.backgroundColor = '#f8f9fa';
            });
            option.addEventListener('mouseout', () => {
                if (index === currentClassIndex) {
                    option.style.backgroundColor = '#e9ecef';
                } else {
                    option.style.backgroundColor = '';
                }
            });

            // Click handler
            option.addEventListener('click', () => {
                // Update annotation class
                annotation.class = index;

                // Update UI
                classNameElement.textContent = className;

                // Save annotations
                saveAnnotations();

                // Redraw annotations
                drawAnnotations();

                // Remove dropdown
                document.body.removeChild(dropdown);
            });

            dropdown.appendChild(option);
        });

        // Add dropdown to body
        document.body.appendChild(dropdown);

        // Close dropdown when clicking outside
        const closeDropdown = (e) => {
            if (!dropdown.contains(e.target) && e.target !== classNameElement) {
                document.body.removeChild(dropdown);
                document.removeEventListener('click', closeDropdown);
            }
        };

        // Add a small delay to prevent immediate closing
        setTimeout(() => {
            document.addEventListener('click', closeDropdown);
        }, 100);
    }

    // Function to draw annotations
    function drawAnnotations() {
        annotCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);

        // Draw existing annotations
        annotations.forEach(annotation => {
            const isSelected = annotation === selectedAnnotation;

            // Set color based on class
            const classIndex = annotation.class % projectClasses.length;
            annotCtx.strokeStyle = getColorForClass(classIndex);
            annotCtx.lineWidth = isSelected ? 3 : 2;

            if (annotation.type === 'box') {
                // Transform coordinates
                const start = transformCoord(annotation.startX, annotation.startY);
                const width = annotation.width * scale;
                const height = annotation.height * scale;

                // Draw box
                annotCtx.beginPath();
                annotCtx.rect(start.x, start.y, width, height);
                annotCtx.stroke();

                // Draw class label
                const className = projectClasses[classIndex];
                annotCtx.fillStyle = annotCtx.strokeStyle;
                annotCtx.font = '12px Arial';
                annotCtx.fillText(className, start.x, start.y - 5);
            } else if (annotation.type === 'polygon') {
                // Draw polygon
                annotCtx.beginPath();

                // Transform first point
                const firstPoint = transformCoord(annotation.points[0][0], annotation.points[0][1]);
                annotCtx.moveTo(firstPoint.x, firstPoint.y);

                // Transform and draw remaining points
                for (let i = 1; i < annotation.points.length; i++) {
                    const point = transformCoord(annotation.points[i][0], annotation.points[i][1]);
                    annotCtx.lineTo(point.x, point.y);
                }

                annotCtx.closePath();
                annotCtx.stroke();

                // Draw points
                annotation.points.forEach(point => {
                    const transformedPoint = transformCoord(point[0], point[1]);
                    annotCtx.beginPath();
                    annotCtx.fillStyle = annotCtx.strokeStyle; // Set fill color to match stroke color
                    annotCtx.arc(transformedPoint.x, transformedPoint.y, isSelected ? 5 : 3, 0, Math.PI * 2);
                    annotCtx.fill();
                });

                // Draw class label
                const className = projectClasses[classIndex];
                annotCtx.fillStyle = annotCtx.strokeStyle;
                annotCtx.font = '12px Arial';
                annotCtx.fillText(className, firstPoint.x, firstPoint.y - 5);
            }
        });

        // Draw current annotation being created
        if (currentAnnotation) {
            // Set color based on class
            const classIndex = currentAnnotation.class % projectClasses.length;
            annotCtx.strokeStyle = getColorForClass(classIndex);
            annotCtx.lineWidth = 2;

            if (currentAnnotation.type === 'box') {
                // Transform coordinates
                const start = transformCoord(currentAnnotation.startX, currentAnnotation.startY);
                const width = currentAnnotation.width * scale;
                const height = currentAnnotation.height * scale;

                // Draw box
                annotCtx.beginPath();
                annotCtx.rect(start.x, start.y, width, height);
                annotCtx.stroke();
            } else if (currentAnnotation.type === 'polygon') {
                // Draw lines between points
                if (currentAnnotation.points.length > 1) {
                    annotCtx.beginPath();

                    // Transform first point
                    const firstPoint = transformCoord(currentAnnotation.points[0][0], currentAnnotation.points[0][1]);
                    annotCtx.moveTo(firstPoint.x, firstPoint.y);

                    // Transform and draw remaining points
                    for (let i = 1; i < currentAnnotation.points.length; i++) {
                        const point = transformCoord(currentAnnotation.points[i][0], currentAnnotation.points[i][1]);
                        annotCtx.lineTo(point.x, point.y);
                    }

                    annotCtx.stroke();
                }

                // Draw points
                currentAnnotation.points.forEach(point => {
                    const transformedPoint = transformCoord(point[0], point[1]);
                    annotCtx.beginPath();
                    annotCtx.fillStyle = annotCtx.strokeStyle; // Set fill color to match stroke color
                    annotCtx.arc(transformedPoint.x, transformedPoint.y, 5, 0, Math.PI * 2);
                    annotCtx.fill();
                });
            }
        }

        // Update the annotations list in the sidebar
        updateAnnotationsList();
    }

    // Function to get color for class
    function getColorForClass(classIndex) {
        // Check if we have a custom color for this class
        if (classColors[classIndex] !== undefined) {
            return classColors[classIndex];
        }

        // Default colors if no custom color is set
        const colors = [
            '#FF0000', // Red
            '#00FF00', // Green
            '#0000FF', // Blue
            '#FFFF00', // Yellow
            '#FF00FF', // Magenta
            '#00FFFF', // Cyan
            '#FFA500', // Orange
            '#800080', // Purple
            '#008000', // Dark Green
            '#000080'  // Navy
        ];

        return colors[classIndex % colors.length];
    }

    // Function to show project settings modal
    function showProjectSettingsModal() {
        // Get project details
        fetch(`/projects/${projectId}`)
            .then(response => response.json())
            .then(data => {
                // Set project name
                document.getElementById('projectName').value = data.name;

                // Clear existing classes
                const classesContainer = document.getElementById('classesContainer');
                classesContainer.innerHTML = '';

                // Add class fields for each class
                data.classes.forEach((className, index) => {
                    // Use custom color if available, otherwise use default color
                    const color = data.classColors && data.classColors[index] 
                        ? data.classColors[index] 
                        : getColorForClass(index);

                    const classItem = createClassField(className, color);
                    classesContainer.appendChild(classItem);
                });

                // Show modal
                const modal = new bootstrap.Modal(document.getElementById('projectSettingsModal'));
                modal.show();
            })
            .catch(error => {
                console.error('Error loading project details:', error);
                alert('Failed to load project details. Please try again.');
            });
    }

    // Function to create a class field
    function createClassField(className = '', color = '#FF0000') {
        const template = document.getElementById('classItemTemplate');
        const clone = document.importNode(template.content, true);

        // Set class name and color
        clone.querySelector('.class-name').value = className;
        clone.querySelector('.class-color').value = color;

        // Add event listener for remove button
        const removeBtn = clone.querySelector('.remove-class');
        removeBtn.addEventListener('click', function() {
            this.closest('.class-item').remove();
        });

        return clone;
    }

    // Function to add a new class field
    function addClassField() {
        const classesContainer = document.getElementById('classesContainer');
        const classItem = createClassField();
        classesContainer.appendChild(classItem);
    }

    // Function to save project settings
    function saveProjectSettings() {
        // Get project name
        const projectName = document.getElementById('projectName').value.trim();

        if (!projectName) {
            alert('Please enter a project name');
            return;
        }

        // Get classes
        const classItems = document.querySelectorAll('.class-item');
        const classes = [];
        const newClassColors = {};

        classItems.forEach((item, index) => {
            const className = item.querySelector('.class-name').value.trim();
            const color = item.querySelector('.class-color').value;

            if (className) {
                classes.push(className);
                newClassColors[index] = color;
            }
        });

        if (classes.length === 0) {
            alert('Please add at least one class');
            return;
        }

        // Update project settings
        fetch(`/projects/${projectId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: projectName,
                classes: classes,
                classColors: newClassColors
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to update project settings');
            }
            return response.json();
        })
        .then(data => {
            // Update local state
            projectName = data.name;
            classColors = newClassColors;

            // Update class selector
            updateClassSelector(data.classes);

            // Redraw annotations with new colors
            drawAnnotations();

            // Close modal
            const modal = bootstrap.Modal.getInstance(document.getElementById('projectSettingsModal'));
            modal.hide();

            alert('Project settings saved successfully');
        })
        .catch(error => {
            console.error('Error saving project settings:', error);
            alert('Failed to save project settings. Please try again.');
        });
    }

    // Function to update class selector
    function updateClassSelector(classes) {
        classSelect.innerHTML = '';

        classes.forEach((className, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = className;
            classSelect.appendChild(option);
        });
    }

    // Function to load annotations for an image
    function loadAnnotations(imageName) {
        // Clear current annotations
        annotations = [];
        selectedAnnotation = null;
        selectedVertex = null;

        // Convert Windows backslashes to forward slashes for URL
        const normalizedImageName = imageName.replace(/\\/g, '/');

        // Try to load from server
        fetch(`/projects/${projectId}/annotations/${encodeURIComponent(normalizedImageName)}`)
            .then(response => response.json())
            .then(data => {
                if (data && data.length > 0) {
                    annotations = data;
                }
                // Always redraw annotations (or clear the canvas if no annotations)
                drawAnnotations();
            })
            .catch(error => {
                console.error('Error loading annotations:', error);
                // In case of error, still clear and redraw
                drawAnnotations();
            });
    }

    // Function to save annotations
    function saveAnnotations() {
        if (!currentImageName) {
            alert('No image selected');
            return;
        }

        // Convert annotations to format for saving
        const annotationsToSave = annotations.map(annotation => {
            // Create a copy to avoid modifying the original
            return { ...annotation };
        });

        // Convert Windows backslashes to forward slashes for URL
        const normalizedImageName = currentImageName.replace(/\\/g, '/');

        // Save to server
        fetch(`/projects/${projectId}/annotations/${encodeURIComponent(normalizedImageName)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(annotationsToSave)
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to save annotations');
            }
            return response.json();
        })
        .then(data => {
            // Success - no need for alert as it would be disruptive for auto-saves
            console.log('Annotations saved successfully');

            // Update the annotations list to reflect the current state
            updateAnnotationsList();
        })
        .catch(error => {
            console.error('Error saving annotations:', error);
            alert('Failed to save annotations. Please try again.');
        });
    }

    // Function to delete selected annotation
    function deleteSelectedAnnotation() {
        if (!selectedAnnotation) {
            alert('No annotation selected');
            return;
        }

        // Remove from annotations array
        const index = annotations.indexOf(selectedAnnotation);
        if (index !== -1) {
            annotations.splice(index, 1);
        }

        // Reset selection state
        selectedAnnotation = null;
        selectedVertex = null;
        isDraggingVertex = false;

        // Update canvas and annotations list
        drawAnnotations();

        // Auto-save annotations after deletion
        saveAnnotations();
    }

    // Function to show export modal
    function showExportModal() {
        const exportModal = new bootstrap.Modal(document.getElementById('exportModal'));
        exportModal.show();
    }

    // Function to export in YOLO format
    function exportYOLO() {
        fetch(`/projects/${projectId}/export`, {
            method: 'POST'
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to export');
            }
            return response.json();
        })
        .then(data => {
            alert('Export successful. Check the export folder in your project directory.');
            // Close modal
            const exportModal = bootstrap.Modal.getInstance(document.getElementById('exportModal'));
            exportModal.hide();
        })
        .catch(error => {
            console.error('Error exporting:', error);
            alert('Failed to export. Please try again.');
        });
    }

    // Function to zoom in/out
    function zoom(factor) {
        scale *= factor;
        displayImage();
    }

    // Function to reset zoom
    function resetZoom() {
        // Reset scale to fit image in container
        if (currentImage) {
            const containerWidth = canvasContainer.parentElement.clientWidth;
            const containerHeight = canvasContainer.parentElement.clientHeight;

            // Calculate scale to fit image in container while maintaining aspect ratio
            const scaleX = containerWidth / currentImage.width;
            const scaleY = containerHeight / currentImage.height;
            scale = Math.min(scaleX, scaleY, 1); // Don't scale up images that are smaller than the container

            // Reset offset values to center the image
            offsetX = 0;
            offsetY = 0;

            displayImage();
        }
    }

    // Function to navigate to the previous image
    function navigateToPreviousImage() {
        if (!localImages.length || !currentImageName) return;

        // Find the index of the current image
        const currentIndex = localImages.findIndex(img => img.name === currentImageName);
        if (currentIndex === -1) return;

        // Calculate the index of the previous image (with wrap-around)
        const prevIndex = (currentIndex - 1 + localImages.length) % localImages.length;

        // Load the previous image
        loadLocalImage(localImages[prevIndex].name);
    }

    // Function to navigate to the next image
    function navigateToNextImage() {
        if (!localImages.length || !currentImageName) return;

        // Find the index of the current image
        const currentIndex = localImages.findIndex(img => img.name === currentImageName);
        if (currentIndex === -1) return;

        // Calculate the index of the next image (with wrap-around)
        const nextIndex = (currentIndex + 1) % localImages.length;

        // Load the next image
        loadLocalImage(localImages[nextIndex].name);
    }

    // Function to update the image counter display
    function updateImageCounter() {
        if (!localImages.length) {
            imageCounter.textContent = 'Image 0 of 0';
            return;
        }

        // Find the index of the current image
        const currentIndex = localImages.findIndex(img => img.name === currentImageName);
        if (currentIndex === -1) {
            imageCounter.textContent = 'Image 0 of ' + localImages.length;
            return;
        }

        // Display 1-based index for better user experience
        const displayIndex = currentIndex + 1;
        imageCounter.textContent = 'Image ' + displayIndex + ' of ' + localImages.length;
    }

    // Handle window resize
    window.addEventListener('resize', displayImage);
});
