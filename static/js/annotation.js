document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
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

    // Tab-related variables
    let currentTab = 'all-images'; // Default tab
    let annotatedImages = []; // Array to store images with annotations
    let unannotatedImages = []; // Array to store images without annotations
    let backgroundImages = []; // Array to store images with background annotations
    let filteredImages = []; // Array to store images filtered by the current tab

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

        // Set up event listener for delete all images button
        if (deleteAllImagesDropdownBtn) {
            deleteAllImagesDropdownBtn.addEventListener('click', confirmDeleteAllImages);
        }

        // Set up event listeners for navigation buttons
        if (prevImageBtn) {
            prevImageBtn.addEventListener('click', navigateToPreviousImage);
        }
        if (nextImageBtn) {
            nextImageBtn.addEventListener('click', navigateToNextImage);
        }

        // Set up event listeners for annotation tools
        if (polygonTool) {
            polygonTool.addEventListener('click', () => setTool('polygon'));
        }
        if (boxTool) {
            boxTool.addEventListener('click', () => setTool('box'));
        }

        // Set up event listener for "Mark as Background" button
        const markAsBackgroundBtn = document.getElementById('markAsBackgroundBtn');
        if (markAsBackgroundBtn) {
            markAsBackgroundBtn.addEventListener('click', markAsBackground);
        }

        // Set up event listeners for filter toggle buttons
        const allImagesTab = document.getElementById('all-images-tab');
        const annotatedImagesTab = document.getElementById('annotated-images-tab');
        const unannotatedImagesTab = document.getElementById('unannotated-images-tab');
        const backgroundImagesTab = document.getElementById('background-images-tab');

        if (allImagesTab) {
            allImagesTab.addEventListener('click', () => switchTab('all-images'));
        }
        if (annotatedImagesTab) {
            annotatedImagesTab.addEventListener('click', () => switchTab('annotated-images'));
        }
        if (unannotatedImagesTab) {
            unannotatedImagesTab.addEventListener('click', () => switchTab('unannotated-images'));
        }
        if (backgroundImagesTab) {
            backgroundImagesTab.addEventListener('click', () => switchTab('background-images'));
        }

        // Initialize tab counts
        updateTabCounts();

        // Add null checks before adding event listeners
        if (confirmExportBtn) {
            confirmExportBtn.addEventListener('click', exportYOLO);
        }
        if (saveProjectSettingsBtn) {
            saveProjectSettingsBtn.addEventListener('click', saveProjectSettings);
        }
        const addClassBtn = document.getElementById('addClass');
        if (addClassBtn) {
            addClassBtn.addEventListener('click', addClassField);
        }

        // Add null checks for zoom controls
        if (zoomIn) {
            zoomIn.addEventListener('click', () => zoom(1.1));
        }
        if (zoomOut) {
            zoomOut.addEventListener('click', () => zoom(0.9));
        }
        if (zoomReset) {
            zoomReset.addEventListener('click', resetZoom);
        }

        // Add mouse wheel zoom support
        if (annotationCanvas) {
            annotationCanvas.addEventListener('wheel', handleMouseWheel, { passive: false });

            // Canvas event listeners
            // Left-click (button 0): Draw polygons and edit vertices
            // Right-click (button 2): Select annotations
            annotationCanvas.addEventListener('mousedown', handleMouseDown);
            annotationCanvas.addEventListener('mousemove', handleMouseMove);
            annotationCanvas.addEventListener('mouseup', handleMouseUp);

            // Prevent context menu on canvas when right-clicking for selection
            annotationCanvas.addEventListener('contextmenu', e => e.preventDefault());
        }

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
                } else {
                    // Generate default colors if not available
                    classColors = {};
                    data.classes.forEach((className, index) => {
                        classColors[index] = getColorForClass(index);
                    });
                }

                // Update class selector with the loaded classes
                updateClassSelector(data.classes);
            })
            .catch(error => {
                console.error('Error loading project data:', error);
            });
    }

    // Function to initialize Socket.IO connection
    function initSocketConnection() {
        // Connect to Socket.IO server with reconnection options
        // Using the same options as in projects.js to ensure compatibility
        socket = io({
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        // Socket.IO event listener for upload_completed has been disabled
        // This ensures users only see images available at the time the annotation page was opened
        // Previously, this would add new images to the list when uploads were completed
        /*
        socket.on('upload_completed', function(data) {
            console.log('Upload completed (annotation page):', data);

            // If we have image info, add the new image to the list
            if (data.image_info) {
                addImageToList(data.image_info);
            }
        });
        */
    }

    // Function to load pending uploads from localStorage - disabled to prevent interference with uploads in projects page
    function loadPendingUploads() {
        console.log('Pending uploads loading disabled in annotation page to prevent interference with uploads in projects page');
        // We don't load or check pending uploads in the annotation page anymore
        // This prevents interference with the upload process managed by the projects page
    }

    // Function to save pending uploads to localStorage - disabled to prevent interference with uploads in projects page
    function savePendingUploads() {
        console.log('Pending uploads saving disabled in annotation page to prevent interference with uploads in projects page');
        // We don't save pending uploads in the annotation page anymore
        // This prevents interference with the upload process managed by the projects page
    }

    // Function to check the status of an upload - disabled to prevent interference with uploads in projects page
    function checkUploadStatus(taskId) {
        console.log('Upload status checking disabled in annotation page to prevent interference with uploads in projects page');
        // We don't check upload status in the annotation page anymore
        // This prevents interference with the upload process managed by the projects page
    }

    // Function to update the upload progress in the UI (not used anymore - progress is shown on project card)
    function updateUploadProgress(taskId, progress, status, error) {
        // This function is no longer used as the upload progress is now shown on the project card
        console.log(`Upload progress: ${progress}%, status: ${status}, task: ${taskId}`);
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
                path: imageInfo.path
            };
        } else {
            // Create image object
            const img = new Image();

            // Load from the server path
            const normalizedImageName = imageInfo.name.replace(/\\/g, '/');
            img.src = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`;

            img.onload = function() {
                // Add to local images array
                localImages.push({
                    name: imageInfo.name,
                    element: img,
                    path: imageInfo.path
                });

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
    // This function works with partially uploaded projects, allowing users to annotate images
    // that have already been uploaded while others are still being uploaded
    function loadSavedImages() {
        // Show loading indicator in the image counter with static "Image 1" and dynamic total count
        imageCounter.innerHTML = 'Image 1 of 0 <div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>';

        console.log(`[loadSavedImages] Starting to load images for project ${projectId}`);

        // Get saved images for this project from the server
        fetch(`/projects/${projectId}/images`)
            .then(response => {
                console.log(`[loadSavedImages] Server response status: ${response.status}`);
                return response.json();
            })
            .then(data => {
                console.log(`[loadSavedImages] Received data:`, data);

                if (data && data.images && data.images.length > 0) {
                    console.log(`[loadSavedImages] Found ${data.images.length} images`);

                    // Reset localImages array to prevent duplication
                    localImages = [];

                    // Create a counter to track loaded images
                    let loadedImagesCount = 0;
                    const totalImages = data.images.length;

                    // Update the image counter with static "Image 1" and initial total count
                    imageCounter.innerHTML = `Image 1 of 0 <div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>`;

                    // Load each saved image
                    data.images.forEach((savedImage, index) => {
                        console.log(`[loadSavedImages] Processing image ${index + 1}/${totalImages}: ${savedImage.name}`);

                        // If we have a path, use it to load the image
                        if (savedImage.path) {
                            // Create image object
                            const img = new Image();

                            // Load from the server path
                            const normalizedImageName = savedImage.name.replace(/\\/g, '/');
                            const imageSrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`;
                            console.log(`[loadSavedImages] Loading image from: ${imageSrc}`);

                            // Add timestamp to prevent caching
                            img.src = `${imageSrc}?t=${new Date().getTime()}`;

                            img.onload = function() {
                                console.log(`[loadSavedImages] Successfully loaded image: ${savedImage.name}`);

                                // Add to local images array
                                localImages.push({
                                    name: savedImage.name,
                                    element: img,
                                    path: savedImage.path
                                });

                                // Increment the loaded images counter
                                loadedImagesCount++;

                                // Update the loading progress with static "Image 1" and dynamic total count
                                imageCounter.innerHTML = `Image 1 of ${loadedImagesCount} <div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>`;

                                // Load the first image if none is loaded
                                if (!currentImage && localImages.length === 1) {
                                    console.log(`[loadSavedImages] Loading first image: ${savedImage.name}`);
                                    loadLocalImage(savedImage.name);
                                }

                                // Update the image counter when all images are loaded
                                if (loadedImagesCount === totalImages) {
                                    console.log(`[loadSavedImages] All ${totalImages} images loaded successfully`);

                                    // Initialize filtered images with all images
                                    filteredImages = [...localImages];

                                    // Update annotation status to categorize images
                                    updateAnnotationStatus();

                                    // Load the first image if there are images available
                                    if (localImages.length > 0 && !currentImage) {
                                        console.log(`[loadSavedImages] Loading first image after all images loaded: ${localImages[0].name}`);
                                        loadLocalImage(localImages[0].name);
                                    }

                                    updateImageCounter();

                                    // Periodic refresh has been disabled as per requirements
                                    // Users will only see images that were available at the time the annotation page was opened
                                    // setUpPeriodicImageRefresh();
                                }
                            };

                            // If image fails to load
                            img.onerror = function() {
                                console.error(`[loadSavedImages] Failed to load image: ${savedImage.name} from path: ${savedImage.path}`);

                                // Try again with a different approach
                                console.log(`[loadSavedImages] Retrying with a different approach for: ${savedImage.name}`);
                                const retryImg = new Image();
                                const retryImageSrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}?retry=true&t=${new Date().getTime()}`;
                                retryImg.src = retryImageSrc;

                                retryImg.onload = function() {
                                    console.log(`[loadSavedImages] Retry successful for image: ${savedImage.name}`);

                                    // Add to local images array
                                    localImages.push({
                                        name: savedImage.name,
                                        element: retryImg,
                                        path: savedImage.path
                                    });

                                    // Increment the loaded images counter
                                    loadedImagesCount++;

                                    // Update the loading progress with static "Image 1" and dynamic total count
                                    imageCounter.innerHTML = `Image 1 of ${loadedImagesCount} <div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>`;

                                    // Load the first image if none is loaded
                                    if (!currentImage && localImages.length === 1) {
                                        loadLocalImage(savedImage.name);
                                    }

                                    // Update the image counter when all images are loaded
                                    if (loadedImagesCount === totalImages) {
                                        // Load the first image if there are images available
                                        if (localImages.length > 0 && !currentImage) {
                                            console.log(`[loadSavedImages] Loading first image after all images loaded (retry): ${localImages[0].name}`);
                                            loadLocalImage(localImages[0].name);
                                        }

                                        updateImageCounter();
                                    }
                                };

                                retryImg.onerror = function() {
                                    console.error(`[loadSavedImages] Retry also failed for image: ${savedImage.name}`);

                                    // Increment the loaded images counter even for failed images
                                    loadedImagesCount++;

                                    // Update the loading progress
                                    imageCounter.innerHTML = `Loading images (${loadedImagesCount}/${totalImages})... <div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div>`;

                                    // Update the image counter when all images are loaded
                                    if (loadedImagesCount === totalImages) {
                                        updateImageCounter();
                                    }
                                };
                            };
                        } else {
                            console.warn(`[loadSavedImages] Image ${savedImage.name} has no path`);
                            loadedImagesCount++;
                        }
                    });

                    // We'll now always load the first image when the page is opened
                    // This is handled in the image loading completion code above
                } else {
                    console.log(`[loadSavedImages] No images found for project ${projectId}`);
                    // No images found, update the counter
                    updateImageCounter();
                }
            })
            .catch(error => {
                console.error(`[loadSavedImages] Error loading saved images:`, error);
                // Update the image counter with error message
                imageCounter.innerHTML = `Error loading images. Please try refreshing the page.`;
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

    // Function to delete an image (no UI update needed since sidebar is removed)
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


    // Function to handle image upload (not used anymore - upload is done from project card)
    function handleImageUpload(event) {
        const files = event.target.files;
        if (files.length === 0) return;

        // Filter for image files only
        const imageFiles = Array.from(files).filter(file => 
            file.type.startsWith('image/') || 
            /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file.name)
        );

        if (imageFiles.length === 0) {
            alert('No image files found in the selected files.');
            return;
        }

        // Add files to the upload queue
        addFilesToUploadQueue(imageFiles);
    }

    // Function to handle folder upload (not used anymore - upload is done from project card)
    function handleFolderUpload(event) {
        const files = event.target.files;
        if (files.length === 0) return;

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
        console.log(`[loadLocalImage] Loading image: ${imageName}`);

        const imageData = localImages.find(img => img.name === imageName);
        if (!imageData) {
            console.error(`[loadLocalImage] Image not found in localImages array: ${imageName}`);
            return;
        }

        console.log(`[loadLocalImage] Found image data:`, imageData);

        // Update current image name and element
        currentImageName = imageName;
        currentImageElement = imageData;

        // If we already have a loaded element, use it directly
        if (imageData.element && imageData.element.complete && imageData.element.naturalWidth !== 0) {
            console.log(`[loadLocalImage] Using already loaded image element`);
            currentImage = imageData.element;
            displayImage();
            loadAnnotations(imageName);
            // Update the image counter display
            updateImageCounter();
            return;
        }

        // Create a new image object to load from server
        const img = new Image();

        // Convert Windows backslashes to forward slashes for URL
        const normalizedImageName = imageName.replace(/\\/g, '/');
        console.log(`[loadLocalImage] Normalized image name: ${normalizedImageName}`);

        // Add timestamp to prevent caching
        const timestamp = new Date().getTime();
        const imageSrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}?t=${timestamp}`;
        console.log(`[loadLocalImage] Loading image from: ${imageSrc}`);

        // Try to load from server using URL format (forward slashes) with timestamp
        img.src = imageSrc;

        img.onload = function() {
            console.log(`[loadLocalImage] Successfully loaded image: ${imageName}`);
            // Update current image with the loaded image
            currentImage = img;

            // Display the image
            displayImage();

            // Load annotations for this image if any
            loadAnnotations(imageName);

            // Update the image counter display
            updateImageCounter();
        };

        img.onerror = function() {
            console.error(`[loadLocalImage] Failed to load image from server: ${imageName}`);

            // Try an alternative approach with different cache-busting parameters
            const retryTimestamp = new Date().getTime();
            const retrySrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}?nocache=true&t=${retryTimestamp}`;
            console.log(`[loadLocalImage] Retrying with: ${retrySrc}`);

            img.src = retrySrc;

            img.onload = function() {
                console.log(`[loadLocalImage] Second attempt succeeded for: ${imageName}`);
                // Update current image with the loaded image
                currentImage = img;
                displayImage();
                loadAnnotations(imageName);

                // Update the image counter display
                updateImageCounter();
            };

            img.onerror = function() {
                console.error(`[loadLocalImage] Second attempt failed for: ${imageName}`);

                // Try a third approach with a different URL format
                const thirdAttemptSrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}?retry=third&t=${new Date().getTime()}`;
                console.log(`[loadLocalImage] Third attempt with: ${thirdAttemptSrc}`);

                const thirdImg = new Image();
                thirdImg.src = thirdAttemptSrc;

                thirdImg.onload = function() {
                    console.log(`[loadLocalImage] Third attempt succeeded for: ${imageName}`);
                    currentImage = thirdImg;
                    displayImage();
                    loadAnnotations(imageName);

                    // Update the image counter display
                    updateImageCounter();
                };

                thirdImg.onerror = function() {
                    console.error(`[loadLocalImage] Third attempt failed for: ${imageName}`);

                    // Fallback to thumbnail if available
                    if (imageData.thumbnail) {
                        console.log(`[loadLocalImage] Trying thumbnail for: ${imageName}`);
                        const thumbImg = new Image();
                        thumbImg.src = imageData.thumbnail;

                        thumbImg.onload = function() {
                            console.log(`[loadLocalImage] Thumbnail loaded for: ${imageName}`);
                            currentImage = thumbImg;
                            displayImage();
                            loadAnnotations(imageName);

                            // Update the image counter display
                            updateImageCounter();
                        };

                        thumbImg.onerror = function() {
                            console.error(`[loadLocalImage] Thumbnail also failed for: ${imageName}`);
                            alert('Failed to load image: ' + imageName);
                        };
                    } else {
                        console.error(`[loadLocalImage] No thumbnail available for: ${imageName}`);
                        alert('Failed to load image: ' + imageName);
                    }
                };
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
        console.log(`[displayImage] Displaying image:`, currentImage);

        if (!currentImage) {
            console.warn(`[displayImage] No current image to display`);
            noImageMessage.style.display = 'block';
            canvasContainer.style.display = 'none';
            return;
        }

        // Check if the image is fully loaded
        if (!currentImage.complete || currentImage.naturalWidth === 0) {
            console.warn(`[displayImage] Image not fully loaded yet:`, currentImage);
            // We'll show a loading message instead of the "no image" message
            noImageMessage.style.display = 'block';
            noImageMessage.innerHTML = 'Loading image... Please wait.';
            canvasContainer.style.display = 'none';

            // Wait for the image to load
            currentImage.onload = function() {
                console.log(`[displayImage] Image now loaded, displaying`);
                displayImage(); // Call this function again once loaded
            };
            return;
        }

        // Use requestAnimationFrame to defer drawing operations to the next frame
        // This helps prevent blocking the main thread during heavy operations
        requestAnimationFrame(() => {
            console.log(`[displayImage] Image dimensions: ${currentImage.width}x${currentImage.height}`);

            noImageMessage.style.display = 'none';
            canvasContainer.style.display = 'block';

            // Set canvas dimensions to match image
            const containerWidth = canvasContainer.parentElement.clientWidth;
            const containerHeight = canvasContainer.parentElement.clientHeight;

            console.log(`[displayImage] Container dimensions: ${containerWidth}x${containerHeight}`);

            // Only calculate initial scale if it hasn't been set by zoom
            if (scale === 1) {
                // Calculate scale to fit image in container while maintaining aspect ratio
                const scaleX = containerWidth / currentImage.width;
                const scaleY = containerHeight / currentImage.height;
                scale = Math.min(scaleX, scaleY, 1); // Don't scale up images that are smaller than the container
                console.log(`[displayImage] Calculated scale: ${scale}`);
            }

            // Set canvas dimensions based on current scale
            const scaledWidth = currentImage.width * scale;
            const scaledHeight = currentImage.height * scale;

            console.log(`[displayImage] Scaled dimensions: ${scaledWidth}x${scaledHeight}`);

            imageCanvas.width = scaledWidth;
            imageCanvas.height = scaledHeight;
            annotationCanvas.width = scaledWidth;
            annotationCanvas.height = scaledHeight;

            // Center canvas in container and apply offset for panning
            canvasContainer.style.width = `${scaledWidth}px`;
            canvasContainer.style.height = `${scaledHeight}px`;
            canvasContainer.style.transform = `translate(${offsetX}px, ${offsetY}px)`;

            try {
                // Draw image
                ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
                ctx.drawImage(currentImage, 0, 0, scaledWidth, scaledHeight);
                console.log(`[displayImage] Image drawn successfully`);
            } catch (error) {
                console.error(`[displayImage] Error drawing image:`, error);
                // Show error message
                noImageMessage.style.display = 'block';
                noImageMessage.innerHTML = 'Error displaying image. Please try refreshing the page.';
                canvasContainer.style.display = 'none';
                return;
            }

            // Draw annotations in the next frame to further reduce main thread blocking
            requestAnimationFrame(() => {
                drawAnnotations();
            });
        });
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

            // Check if there's a background annotation and remove it without confirmation
            const hasBackgroundAnnotation = annotations.some(annotation => annotation.type === 'background');
            if (hasBackgroundAnnotation) {
                // Remove the background annotation
                annotations = annotations.filter(annotation => annotation.type !== 'background');
                console.log('Background annotation removed automatically');

                // Update the canvas to reflect the changes
                drawAnnotations();

                // Save the updated annotations
                saveAnnotations();
            }

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

        // If the annotationsList element doesn't exist, return early
        if (!annotationsList) {
            return;
        }

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

            // Special handling for background annotations
            if (annotation.type === 'background') {
                // Create a special item for background annotations
                item.innerHTML = '';
                item.className = 'annotation-item background-annotation';

                // Add a special badge
                const backgroundBadge = document.createElement('span');
                backgroundBadge.className = 'annotation-type background';
                backgroundBadge.textContent = 'Background';

                // Add a description
                const description = document.createElement('span');
                description.className = 'annotation-description';
                description.textContent = 'No objects in this image';

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
                item.appendChild(backgroundBadge);
                item.appendChild(description);
                item.appendChild(deleteBtn);

                // Add click event to select the annotation
                item.addEventListener('click', () => {
                    selectedAnnotation = annotation;
                    selectedVertex = null;
                    isDraggingVertex = false;
                    drawAnnotations();
                });

                annotationsList.appendChild(item);
                return; // Skip the rest of the processing for this annotation
            }

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

            // Handle background annotation type
            if (annotation.type === 'background') {
                // Display a message on the canvas indicating this is a background image
                annotCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                annotCtx.font = 'bold 24px Arial';
                annotCtx.textAlign = 'center';
                annotCtx.fillText('Background Image (No Objects)', annotationCanvas.width / 2, 30);

                // Add a subtle border to indicate it's annotated
                annotCtx.strokeStyle = 'rgba(0, 200, 0, 0.5)';
                annotCtx.lineWidth = 4;
                annotCtx.strokeRect(10, 10, annotationCanvas.width - 20, annotationCanvas.height - 20);

                // Update the annotations list
                updateAnnotationsList();
                return; // Skip the rest of the drawing for this annotation
            }

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

            // Apply class color as background color
            const color = classColors[index] || getColorForClass(index);
            option.style.backgroundColor = color;

            // Set text color to white or black based on background color brightness
            const rgb = hexToRgb(color);
            const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
            option.style.color = brightness > 128 ? 'black' : 'white';

            classSelect.appendChild(option);
        });
    }

    // Helper function to convert hex color to RGB
    function hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace('#', '');

        // Parse the hex values
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        return { r, g, b };
    }

    // Function to load annotations for an image
    function loadAnnotations(imageName) {
        // Use setTimeout to defer annotation loading to the next tick of the event loop
        // This prevents blocking the main thread during heavy operations
        setTimeout(() => {
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
        }, 0);
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

    // Function to navigate to the previous image using AJAX
    function navigateToPreviousImage() {
        if (!currentImageName) return;

        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div> Loading previous image...';
        document.querySelector('.main-content').appendChild(loadingIndicator);

        // Use AJAX to get the previous image from the server
        fetch(`/projects/${projectId}/navigate_image?current_image=${encodeURIComponent(currentImageName)}&direction=previous&tab=${currentTab}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to navigate to previous image');
                }
                return response.json();
            })
            .then(data => {
                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // If we have an image, load it
                if (data.image) {
                    loadLocalImage(data.image.name);
                } else {
                    console.error('No image returned from server');
                }
            })
            .catch(error => {
                console.error('Error navigating to previous image:', error);

                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // Show error message
                alert('Failed to navigate to previous image. Please try again.');
            });
    }

    // Function to navigate to the next image using AJAX
    function navigateToNextImage() {
        if (!currentImageName) return;

        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div> Loading next image...';
        document.querySelector('.main-content').appendChild(loadingIndicator);

        // Use AJAX to get the next image from the server
        fetch(`/projects/${projectId}/navigate_image?current_image=${encodeURIComponent(currentImageName)}&direction=next&tab=${currentTab}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to navigate to next image');
                }
                return response.json();
            })
            .then(data => {
                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // If we have an image, load it
                if (data.image) {
                    loadLocalImage(data.image.name);
                } else {
                    console.error('No image returned from server');
                }
            })
            .catch(error => {
                console.error('Error navigating to next image:', error);

                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // Show error message
                alert('Failed to navigate to next image. Please try again.');
            });
    }

    // Function to switch between image filters using AJAX
    function switchTab(tabId) {
        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div> Loading images...';
        document.querySelector('.main-content').appendChild(loadingIndicator);

        // Update current tab
        currentTab = tabId;

        // Update active state of toggle buttons
        document.getElementById('all-images-tab').classList.remove('active');
        document.getElementById('annotated-images-tab').classList.remove('active');
        document.getElementById('unannotated-images-tab').classList.remove('active');
        document.getElementById('background-images-tab').classList.remove('active');
        document.getElementById(tabId + '-tab').classList.add('active');

        // Use AJAX to get filtered images from the server
        fetch(`/projects/${projectId}/filtered_images?tab=${tabId}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to get filtered images');
                }
                return response.json();
            })
            .then(data => {
                // Update local arrays with the filtered images
                localImages = data.images || [];

                // Update filtered images based on the current tab
                filteredImages = [...localImages];

                // Update the image counter and tab counts
                updateImageCounter();
                updateTabCounts();

                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // If there are filtered images, load the first one
                if (filteredImages.length > 0) {
                    loadLocalImage(filteredImages[0].name);
                } else {
                    // If no images in the current filter, show a message
                    clearCanvas();
                    noImageMessage.style.display = 'block';
                    noImageMessage.textContent = 'No images in the current filter. Switch to a different filter or add more images.';
                }
            })
            .catch(error => {
                console.error('Error switching tab:', error);

                // Remove loading indicator
                if (loadingIndicator.parentNode) {
                    loadingIndicator.parentNode.removeChild(loadingIndicator);
                }

                // Show error message
                alert('Failed to load images. Please try again.');
            });
    }

    // Function to update toggle button text with image counts
    function updateTabCounts() {
        // Update the toggle button text with the count of images in each category
        document.getElementById('all-images-tab').textContent = `All Images (${localImages.length})`;
        document.getElementById('annotated-images-tab').textContent = `Annotated Images (${annotatedImages.length})`;
        document.getElementById('unannotated-images-tab').textContent = `Images without Annotations (${unannotatedImages.length})`;
        document.getElementById('background-images-tab').textContent = `Background (${backgroundImages.length})`;
    }

    // Function to filter images based on the current tab
    function filterImages() {
        // Filter images based on the current tab
        if (currentTab === 'all-images') {
            filteredImages = [...localImages];
        } else if (currentTab === 'annotated-images') {
            filteredImages = [...annotatedImages];
        } else if (currentTab === 'unannotated-images') {
            filteredImages = [...unannotatedImages];
        } else if (currentTab === 'background-images') {
            filteredImages = [...backgroundImages];
        }

        // Update the image counter
        updateImageCounter();

        // Update tab counts
        updateTabCounts();
    }

    // Function to update the annotation status of all images
    function updateAnnotationStatus() {
        // Clear the arrays
        annotatedImages = [];
        unannotatedImages = [];
        backgroundImages = [];

        // Limit the number of concurrent API calls to avoid overwhelming the server
        // and to prevent interference with the upload process
        const batchSize = 3; // Reduced batch size to 3 images at a time to reduce server load
        const imagesToProcess = [...localImages]; // Create a copy of the array
        const results = [];

        // Process images in batches
        function processBatch() {
            if (imagesToProcess.length === 0) {
                // All images processed, update the UI
                return Promise.resolve(results);
            }

            // Take the next batch of images
            const batch = imagesToProcess.splice(0, batchSize);

            // Process this batch
            const batchPromises = batch.map(image => {
                return checkImageAnnotationStatus(image.name)
                    .then(result => {
                        if (result.hasAnnotations) {
                            annotatedImages.push(image);

                            // If it has a background annotation, add to background images array
                            if (result.hasBackgroundAnnotation) {
                                backgroundImages.push(image);
                            }
                        } else {
                            unannotatedImages.push(image);
                        }
                        results.push(result);
                    });
            });

            // Wait for this batch to complete, then process the next batch
            return Promise.all(batchPromises).then(() => {
                // Add a longer delay between batches to allow other operations (like uploads) to proceed
                // This significantly reduces contention with the upload process
                return new Promise(resolve => setTimeout(() => resolve(processBatch()), 200));
            });
        }

        // Start processing batches and return the promise
        return processBatch().then(() => {
            // Update the filtered images based on the current tab
            filterImages();

            // Log the counts for debugging
            console.log(`Annotation status updated: ${annotatedImages.length} annotated, ${unannotatedImages.length} unannotated, ${backgroundImages.length} background`);
        });
    }

    // Function to check if an image has annotations
    function checkImageAnnotationStatus(imageName) {
        return new Promise((resolve) => {
            // Add a significant delay before making the API call to reduce contention with uploads
            // This helps prevent overwhelming the server with too many concurrent requests
            // and allows upload operations to proceed without interference
            setTimeout(() => {
                // Convert Windows backslashes to forward slashes for URL
                const normalizedImageName = imageName.replace(/\\/g, '/');

                // Try to load annotations from server
                fetch(`/projects/${projectId}/annotations/${encodeURIComponent(normalizedImageName)}`)
                    .then(response => response.json())
                    .then(data => {
                        // Check if there are any annotations
                        const hasAnnotations = data && data.length > 0;

                        // Check if there's a background annotation
                        const hasBackgroundAnnotation = hasAnnotations && data.some(annotation => annotation.type === 'background');

                        // Resolve with an object containing both flags
                        resolve({
                            hasAnnotations,
                            hasBackgroundAnnotation
                        });
                    })
                    .catch(error => {
                        console.error('Error checking annotation status:', error);
                        // If there's an error, assume no annotations
                        resolve({
                            hasAnnotations: false,
                            hasBackgroundAnnotation: false
                        });
                    });
            }, 50); // Increased to 50ms delay to significantly reduce contention with uploads
        });
    }

    // Function to mark the current image as background (no objects) using AJAX
    function markAsBackground() {
        if (!currentImageName) {
            alert('No image selected');
            return;
        }

        // Check if there are any non-background annotations
        const hasNonBackgroundAnnotations = annotations.some(annotation => annotation.type !== "background");

        // If there are non-background annotations, show a warning
        if (hasNonBackgroundAnnotations) {
            if (!confirm('Warning: This will delete all existing annotations for this image. Do you want to continue?')) {
                return; // User cancelled
            }
        }

        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'loading-indicator';
        loadingIndicator.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading...</span></div> Marking as background...';
        document.querySelector('.main-content').appendChild(loadingIndicator);

        // Use AJAX to mark the image as background
        fetch(`/projects/${projectId}/mark_as_background`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image_name: currentImageName
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to mark image as background');
            }
            return response.json();
        })
        .then(data => {
            // Remove loading indicator
            if (loadingIndicator.parentNode) {
                loadingIndicator.parentNode.removeChild(loadingIndicator);
            }

            // Create a background annotation for local display
            const backgroundAnnotation = [{
                "type": "background",
                "class": null,
                "points": []
            }];

            // Set the annotations array
            annotations = backgroundAnnotation;

            // Draw the background annotation on the canvas
            drawAnnotations();

            // Refresh the current tab to update the filtered images
            switchTab(currentTab);
        })
        .catch(error => {
            console.error('Error marking image as background:', error);

            // Remove loading indicator
            if (loadingIndicator.parentNode) {
                loadingIndicator.parentNode.removeChild(loadingIndicator);
            }

            // Show error message
            alert('Failed to mark image as background. Please try again.');
        });
    }

    // Function to clear the canvas
    function clearCanvas() {
        // Clear the annotation canvas
        annotCtx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);

        // Clear the image canvas
        ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);

        // Hide the canvas container
        canvasContainer.style.display = 'none';
    }

    // Function to update the image counter display
    function updateImageCounter() {
        if (!filteredImages.length) {
            imageCounter.textContent = 'Image 0 of 0';
            return;
        }

        // Find the index of the current image in the filtered images
        const currentIndex = filteredImages.findIndex(img => img.name === currentImageName);
        if (currentIndex === -1) {
            imageCounter.textContent = 'Image 0 of ' + filteredImages.length;
            return;
        }

        // Display 1-based index for better user experience
        const displayIndex = currentIndex + 1;
        imageCounter.textContent = 'Image ' + displayIndex + ' of ' + filteredImages.length;
    }

    // Function to set up periodic refresh to check for new images
    // This allows the annotation page to see new images as they're uploaded
    let imageRefreshInterval = null;
    function setUpPeriodicImageRefresh() {
        // Clear any existing interval
        if (imageRefreshInterval) {
            clearInterval(imageRefreshInterval);
        }

        // Set up a new interval to check for new images every 30 seconds
        imageRefreshInterval = setInterval(() => {
            console.log('Checking for new images...');

            // Get the current list of images
            fetch(`/projects/${projectId}/images`)
                .then(response => response.json())
                .then(data => {
                    if (data && data.images && data.images.length > 0) {
                        // Check if there are new images
                        const currentImageCount = localImages.length;
                        const newImageCount = data.images.length;

                        if (newImageCount > currentImageCount) {
                            console.log(`Found ${newImageCount - currentImageCount} new images. Refreshing...`);

                            // Process only the new images
                            const existingImageNames = localImages.map(img => img.name);
                            const newImages = data.images.filter(img => !existingImageNames.includes(img.name));

                            // Load each new image
                            newImages.forEach(savedImage => {
                                if (savedImage.path) {
                                    // Create image object
                                    const img = new Image();

                                    // Load from the server path
                                    const normalizedImageName = savedImage.name.replace(/\\/g, '/');
                                    const imageSrc = `/projects/${projectId}/images/${encodeURIComponent(normalizedImageName)}`;

                                    // Add timestamp to prevent caching
                                    img.src = `${imageSrc}?t=${new Date().getTime()}`;

                                    img.onload = function() {
                                        console.log(`Successfully loaded new image: ${savedImage.name}`);

                                        // Add to local images array
                                        localImages.push({
                                            name: savedImage.name,
                                            element: img,
                                            path: savedImage.path
                                        });

                                        // Update the image counter
                                        updateImageCounter();
                                    };

                                    img.onerror = function() {
                                        console.error(`Failed to load new image: ${savedImage.name}`);
                                    };
                                }
                            });
                        } else {
                            console.log('No new images found.');
                        }
                    }
                })
                .catch(error => {
                    console.error('Error checking for new images:', error);
                });
        }, 30000); // Check every 30 seconds
    }

    // Handle window resize
    window.addEventListener('resize', displayImage);
});
