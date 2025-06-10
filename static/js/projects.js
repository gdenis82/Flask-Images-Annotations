document.addEventListener('DOMContentLoaded', function() {
    // Load projects when the page loads
    loadProjects();

    // Initialize Socket.IO connection
    initSocketConnection();

    // Add event listeners
    document.getElementById('addClass').addEventListener('click', addClassField);
    document.getElementById('createProjectBtn').addEventListener('click', createProject);
    document.getElementById('settingsAddClass').addEventListener('click', addSettingsClassField);
    document.getElementById('saveProjectSettingsBtn').addEventListener('click', saveProjectSettings);

    // Add event listener for the first remove class button
    const firstRemoveBtn = document.querySelector('.remove-class');
    if (firstRemoveBtn) {
        firstRemoveBtn.addEventListener('click', function() {
            removeClassField(this);
        });
    }

    // Set up file input elements
    const projectImageUpload = document.getElementById('projectImageUpload');
    const projectFolderUpload = document.getElementById('projectFolderUpload');

    // Add event listeners for file inputs
    projectImageUpload.addEventListener('change', function(event) {
        const projectId = this.dataset.projectId;
        const cardId = this.dataset.cardId;
        if (projectId && cardId) {
            const card = document.getElementById(cardId);
            if (card) {
                handleImageUpload(event, projectId, card);
            }
        }
    });

    projectFolderUpload.addEventListener('change', function(event) {
        const projectId = this.dataset.projectId;
        const cardId = this.dataset.cardId;
        if (projectId && cardId) {
            const card = document.getElementById(cardId);
            if (card) {
                handleFolderUpload(event, projectId, card);
            }
        }
    });

    // Load any pending uploads from localStorage
    loadAllPendingUploads();

    // Add beforeunload event listener to prevent page closing during upload
    window.addEventListener('beforeunload', function(e) {
        if (isUploading) {
            // Cancel the event
            e.preventDefault();
            // Chrome requires returnValue to be set
            e.returnValue = 'You have uploads in progress. Are you sure you want to leave?';
            return 'You have uploads in progress. Are you sure you want to leave?';
        }
    });
});

// Function to initialize Socket.IO connection
function initSocketConnection() {
    // Connect to Socket.IO server with reconnection options
    socket = io({
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
    });

    // Handle reconnection events
    socket.on('connect', function() {
        console.log('Socket.IO connected');

        // If we have pending uploads, check their status
        if (Object.keys(pendingUploads).length > 0) {
            console.log('Checking status of pending uploads after reconnection');
            Object.keys(pendingUploads).forEach(taskId => {
                const projectId = pendingUploads[taskId].projectId;
                if (projectId) {
                    checkUploadStatus(taskId, projectId);
                }
            });
        }
    });

    socket.on('disconnect', function() {
        console.log('Socket.IO disconnected');
    });

    socket.on('reconnect', function(attemptNumber) {
        console.log(`Socket.IO reconnected after ${attemptNumber} attempts`);

        // If we have pending uploads, check their status
        if (Object.keys(pendingUploads).length > 0) {
            console.log('Checking status of pending uploads after reconnection');
            Object.keys(pendingUploads).forEach(taskId => {
                const projectId = pendingUploads[taskId].projectId;
                if (projectId) {
                    checkUploadStatus(taskId, projectId);
                }
            });
        }
    });

    socket.on('reconnect_attempt', function(attemptNumber) {
        console.log(`Socket.IO reconnect attempt ${attemptNumber}`);
    });

    socket.on('reconnect_error', function(error) {
        console.error('Socket.IO reconnect error:', error);
    });

    socket.on('reconnect_failed', function() {
        console.error('Socket.IO reconnect failed');
    });

    // Listen for upload progress events
    socket.on('upload_progress', function(data) {
        console.log('Upload progress:', data);

        // Update the pending upload status
        if (pendingUploads[data.task_id]) {
            pendingUploads[data.task_id].status = data.status;
            pendingUploads[data.task_id].progress = data.progress;
            const projectId = pendingUploads[data.task_id].projectId;

            // Update the UI to show the progress
            updateUploadProgress(projectId, data.progress, data.status);

            // Save to localStorage
            savePendingUploads(data.project_id);
        }
    });

    // Listen for upload completed events
    socket.on('upload_completed', function(data) {
        console.log('Upload completed:', data);

        // Update the pending upload status
        if (pendingUploads[data.task_id]) {
            pendingUploads[data.task_id].status = 'completed';
            pendingUploads[data.task_id].progress = 100;
            pendingUploads[data.task_id].image_info = data.image_info;
            const projectId = pendingUploads[data.task_id].projectId;

            // Update the UI to show the completed upload
            updateUploadProgress(projectId, 100, 'completed');

            // Increment completed uploads counter only if not already counted
            if (!countedTasks[data.task_id]) {
                if (!projectCompletedUploads[projectId]) {
                    projectCompletedUploads[projectId] = 0;
                }
                projectCompletedUploads[projectId]++;
                countedTasks[data.task_id] = true;
            }

            // We'll update the image count only at the end of the upload process
            // to ensure we show the real number of files in the project

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[data.task_id];
                savePendingUploads(data.project_id);
            }, 5000);
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
            const projectId = pendingUploads[data.task_id].projectId;

            // Update the UI to show the failed upload
            updateUploadProgress(projectId, 0, 'failed');

            // Increment failed uploads counter
            if (!projectFailedUploads[projectId]) {
                projectFailedUploads[projectId] = 0;
            }
            projectFailedUploads[projectId]++;

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[data.task_id];
                savePendingUploads(data.project_id);
            }, 5000);
        }

        // Process next item in queue
        processUploadQueue();
    });
}

// Function to load projects
function loadProjects() {
    // Show loading indicator
    const projectsList = document.getElementById('projectsList');
    const noProjectsMessage = document.getElementById('noProjectsMessage');

    // Clear existing projects
    projectsList.innerHTML = '';

    // Show loading indicator
    projectsList.innerHTML = `
        <div class="col-12 text-center my-5">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading projects...</span>
            </div>
            <p class="mt-2">Loading projects...</p>
        </div>
    `;

    fetch('/projects')
        .then(response => {
            console.log('Load projects response:', response);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json().then(data => {
                console.log('Load projects data:', data);
                return data;
            });
        })
        .then(projects => {
            // Check if projects is an array
            if (!Array.isArray(projects)) {
                console.error('Invalid projects data:', projects);
                return;
            }

            // Clear loading indicator
            projectsList.innerHTML = '';

            if (projects.length === 0) {
                noProjectsMessage.style.display = 'block';
            } else {
                noProjectsMessage.style.display = 'none';

                // Create a card for each project
                projects.forEach(project => {
                    // Create a copy of the project with placeholders for imageCount and annotationsCount
                    // This allows us to display the card immediately without waiting for counts
                    const projectWithPlaceholders = {
                        ...project,
                        imageCount: '...',
                        annotationsCount: {}
                    };

                    const projectCard = createProjectCard(projectWithPlaceholders);
                    projectsList.appendChild(projectCard);

                    // Update counts in the background with a small delay between each project
                    // to avoid overwhelming the server with requests
                    setTimeout(() => {
                        updateProjectImageCount(project.id);
                    }, Math.random() * 1000); // Random delay between 0-1000ms to stagger requests
                });
            }
        })
        .catch(error => {
            console.error('Error loading projects:', error);
            // Show error message in the projects list
            projectsList.innerHTML = `
                <div class="col-12 text-center my-5">
                    <div class="alert alert-danger" role="alert">
                        Failed to load projects. Please try refreshing the page.
                    </div>
                </div>
            `;
        });
}

// Function to create a project card
function createProjectCard(project) {
    const template = document.getElementById('projectCardTemplate');
    const clone = document.importNode(template.content, true);

    // Set project details
    clone.querySelector('.project-name').textContent = project.name;

    // Format date
    if (project.created) {
        const date = new Date(project.created);
        clone.querySelector('.project-date').textContent = `Created: ${date.toLocaleDateString()}`;
    }

    // Set classes
    let classesText = '';
    if (project.classes && project.classes.length > 0) {
        classesText = `Classes: ${project.classes.join(', ')}`;
    } else {
        classesText = 'No classes defined';
    }

    // Add image count
    let statsHtml = '';
    if (project.imageCount !== undefined) {
        // If imageCount is a placeholder ('...'), show 0 instead of loading indicator
        const displayCount = project.imageCount === '...' ? 0 : project.imageCount;
        statsHtml += `<div><strong>Images:</strong> <span class="image-count">${displayCount}</span></div>`;
    }

    // Add annotation counts per class
    if (project.annotationsCount) {
        statsHtml += '<div><strong>Annotations:</strong></div>';

        // Check if we have any annotation counts
        if (Object.keys(project.annotationsCount).length > 0) {
            statsHtml += '<ul class="annotation-stats">';
            for (const [className, count] of Object.entries(project.annotationsCount)) {
                statsHtml += `<li>${className}: <span class="annotation-count">${count}</span></li>`;
            }
            statsHtml += '</ul>';
        } else {
            // If no annotation counts yet, show 0 instead of loading indicator
            statsHtml += '<ul class="annotation-stats"><li><span class="annotation-count">0</span></li></ul>';
        }
    } else {
        // If annotationsCount is undefined, show 0 instead of loading indicator
        statsHtml += '<div><strong>Annotations:</strong></div>';
        statsHtml += '<ul class="annotation-stats"><li><span class="annotation-count">0</span></li></ul>';
    }

    // Set classes and stats
    clone.querySelector('.project-classes').innerHTML = classesText;

    // Add stats element if it doesn't exist
    if (!clone.querySelector('.project-stats')) {
        const statsDiv = document.createElement('div');
        statsDiv.className = 'project-stats mt-2';
        const cardBody = clone.querySelector('.card-body');
        const uploadControls = clone.querySelector('.upload-controls');
        cardBody.insertBefore(statsDiv, uploadControls);
    }

    // Set stats
    clone.querySelector('.project-stats').innerHTML = statsHtml;

    // Set open link
    const openLink = clone.querySelector('.open-project');
    openLink.href = `/annotate/${project.id}`;

    // Add settings event listener
    const settingsBtn = clone.querySelector('.settings-project');
    settingsBtn.addEventListener('click', function() {
        showProjectSettings(project);
    });

    // Add export event listener
    const exportBtn = clone.querySelector('.export-project');
    exportBtn.addEventListener('click', function() {
        exportProject(project.id, project.name);
    });

    // Add delete event listener
    const deleteBtn = clone.querySelector('.delete-project');
    deleteBtn.addEventListener('click', function() {
        if (confirm(`Are you sure you want to delete the project "${project.name}"?`)) {
            deleteProject(project.id);
        }
    });

    // Add upload images event listener
    const uploadImagesBtn = clone.querySelector('.upload-images');
    uploadImagesBtn.addEventListener('click', function() {
        // Store project ID in the file input
        const projectImageUpload = document.getElementById('projectImageUpload');
        projectImageUpload.dataset.projectId = project.id;
        projectImageUpload.dataset.cardId = this.closest('.card').id;

        // Generate a unique ID for the card if it doesn't have one
        const card = this.closest('.card');
        if (!card.id) {
            card.id = `project-card-${project.id}`;
        }

        // Trigger file input click
        projectImageUpload.click();
    });

    // Add upload folder event listener
    const uploadFolderBtn = clone.querySelector('.upload-folder');
    uploadFolderBtn.addEventListener('click', function() {
        // Store project ID in the file input
        const projectFolderUpload = document.getElementById('projectFolderUpload');
        projectFolderUpload.dataset.projectId = project.id;
        projectFolderUpload.dataset.cardId = this.closest('.card').id;

        // Generate a unique ID for the card if it doesn't have one
        const card = this.closest('.card');
        if (!card.id) {
            card.id = `project-card-${project.id}`;
        }

        // Trigger file input click
        projectFolderUpload.click();
    });

    // Add delete all images event listener
    const deleteAllImagesBtn = clone.querySelector('.delete-all-images');
    if (deleteAllImagesBtn) {
        deleteAllImagesBtn.addEventListener('click', function() {
            if (confirm(`Are you sure you want to delete ALL images in project "${project.name}"? This action cannot be undone.`)) {
                deleteAllImages(project.id, this.closest('.card'));
            }
        });
    }

    // Generate a unique ID for the card
    clone.querySelector('.card').id = `project-card-${project.id}`;

    return clone;
}

// Function to add a new class field
function addClassField() {
    const classesContainer = document.getElementById('classesContainer');

    // Create new input group
    const inputGroup = document.createElement('div');
    inputGroup.className = 'input-group mb-2';

    // Create input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control class-input';
    input.placeholder = 'Class name';

    // Create remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-outline-secondary remove-class';
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function() {
        removeClassField(this);
    });

    // Add elements to input group
    inputGroup.appendChild(input);
    inputGroup.appendChild(removeBtn);

    // Add input group to container
    classesContainer.appendChild(inputGroup);
}

// Function to remove a class field
function removeClassField(button) {
    const inputGroup = button.parentElement;
    const classesContainer = document.getElementById('classesContainer');

    // Don't remove if it's the only class field
    if (classesContainer.children.length > 1) {
        classesContainer.removeChild(inputGroup);
    }
}

// Function to create a new project
function createProject() {
    const projectName = document.getElementById('projectName').value.trim();

    if (!projectName) {
        alert('Please enter a project name');
        return;
    }

    // Get all class inputs
    const classInputs = document.querySelectorAll('.class-input');
    const classes = [];

    classInputs.forEach(input => {
        const className = input.value.trim();
        if (className) {
            classes.push(className);
        }
    });

    // Create project data
    const projectData = {
        name: projectName,
        classes: classes,
        classColors: {}
    };

    // Assign default colors to classes
    classes.forEach((className, index) => {
        projectData.classColors[index] = getColorForClass(index);
    });

    // Show loading indicator
    const createProjectBtn = document.getElementById('createProjectBtn');
    const originalBtnText = createProjectBtn.textContent;
    createProjectBtn.textContent = 'Creating...';
    createProjectBtn.disabled = true;

    // Send request to create project
    fetch('/projects', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(projectData)
    })
    .then(response => {
        console.log('Project creation response:', response);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json().then(data => {
            console.log('Project creation data:', data);
            return data;
        });
    })
    .then(data => {
        // Validate the response data
        if (!data || !data.id || !data.name) {
            throw new Error('Invalid project data received from server');
        }

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('createProjectModal'));
        modal.hide();

        // Reset form
        document.getElementById('projectName').value = '';
        const classesContainer = document.getElementById('classesContainer');
        classesContainer.innerHTML = `
            <div class="input-group mb-2">
                <input type="text" class="form-control class-input" placeholder="Class name">
                <button class="btn btn-outline-secondary remove-class" type="button">Remove</button>
            </div>
        `;

        // Add event listener for the new remove button
        const removeBtn = document.querySelector('.remove-class');
        if (removeBtn) {
            removeBtn.addEventListener('click', function() {
                removeClassField(this);
            });
        }

        // Add the new project to the UI directly
        const projectsList = document.getElementById('projectsList');
        const noProjectsMessage = document.getElementById('noProjectsMessage');

        // Hide the "no projects" message
        noProjectsMessage.style.display = 'none';

        // Create a project object with the data returned from the server
        const project = {
            id: data.id,
            name: data.name,
            created: data.created || new Date().toISOString(),
            classes: data.classes || [],
            classColors: data.classColors || {},
            imageCount: 0,
            annotationsCount: {}
        };

        // Create a card for the new project
        const projectCard = createProjectCard(project);
        projectsList.appendChild(projectCard);

        // Update the project counts after a short delay
        setTimeout(() => {
            updateProjectImageCount(project.id);
        }, 500);

        console.log('Project created successfully:', project);
    })
    .catch(error => {
        console.error('Error creating project:', error);
        alert('Failed to create project. Please try again.');
    })
    .finally(() => {
        // Reset button state
        createProjectBtn.textContent = originalBtnText;
        createProjectBtn.disabled = false;
    });
}

// Function to delete a project
function deleteProject(projectId) {
    fetch(`/projects/${projectId}`, {
        method: 'DELETE'
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to delete project');
        }
        return response.json();
    })
    .then(data => {
        // Reload projects
        loadProjects();
    })
    .catch(error => {
        console.error('Error deleting project:', error);
        alert('Failed to delete project. Please try again.');
    });
}

// Function to export a project in YOLO format
function exportProject(projectId, projectName) {
    if (confirm(`Export project "${projectName}" in YOLO format?`)) {
        fetch(`/projects/${projectId}/export`, {
            method: 'POST'
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to export project');
            }
            return response.json();
        })
        .then(data => {
            alert('Export successful. Check the export folder in your project directory.');
        })
        .catch(error => {
            console.error('Error exporting project:', error);
            alert('Failed to export project. Please try again.');
        });
    }
}

// Function to delete all images in a project
function deleteAllImages(projectId, card) {
    // First, get the project details to get the list of images
    fetch(`/projects/${projectId}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to get project details');
            }
            return response.json();
        })
        .then(project => {
            if (!project.images || project.images.length === 0) {
                alert('No images to delete.');
                return;
            }

            // Show progress in the card
            const progressContainer = card.querySelector('.upload-progress-container');
            const progressBar = card.querySelector('.progress-bar');
            const statusElement = card.querySelector('.upload-status');

            if (progressContainer && progressBar && statusElement) {
                progressContainer.style.display = 'block';
                progressBar.style.width = '0%';
                progressBar.setAttribute('aria-valuenow', 0);
                progressBar.textContent = '0%';
                statusElement.textContent = `Deleting 0/${project.images.length} images...`;
            }

            // Delete each image one by one
            let deletedCount = 0;
            let errorCount = 0;

            const deleteNextImage = (index) => {
                if (index >= project.images.length) {
                    // All images processed
                    if (errorCount > 0) {
                        statusElement.textContent = `Deletion completed with ${errorCount} errors.`;
                    } else {
                        statusElement.textContent = 'All images deleted successfully.';
                    }

                    // Update progress bar to 100%
                    progressBar.style.width = '100%';
                    progressBar.setAttribute('aria-valuenow', 100);
                    progressBar.textContent = '100%';

                    // Hide progress container after a delay
                    setTimeout(() => {
                        progressContainer.style.display = 'none';
                    }, 3000);

                    // Update the project image count to show zero
                    updateProjectImageCount(projectId);
                    return;
                }

                const imageName = project.images[index];
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
                    deletedCount++;

                    // Update progress
                    const progress = Math.round((deletedCount / project.images.length) * 100);
                    progressBar.style.width = `${progress}%`;
                    progressBar.setAttribute('aria-valuenow', progress);
                    progressBar.textContent = `${progress}%`;
                    statusElement.textContent = `Deleted ${deletedCount}/${project.images.length} images...`;

                    // Process next image
                    deleteNextImage(index + 1);
                })
                .catch(error => {
                    console.error(`Error deleting image ${imageName}:`, error);
                    errorCount++;
                    deletedCount++;

                    // Update progress
                    const progress = Math.round((deletedCount / project.images.length) * 100);
                    progressBar.style.width = `${progress}%`;
                    progressBar.setAttribute('aria-valuenow', progress);
                    progressBar.textContent = `${progress}%`;
                    statusElement.textContent = `Deleted ${deletedCount}/${project.images.length} images (${errorCount} errors)...`;

                    // Process next image
                    deleteNextImage(index + 1);
                });
            };

            // Start deleting images
            deleteNextImage(0);
        })
        .catch(error => {
            console.error('Error getting project details:', error);
            alert('Failed to delete images. Please try again.');
        });
}

// Function to show project settings
function showProjectSettings(project) {
    // Set project name
    document.getElementById('settingsProjectName').value = project.name;

    // Clear existing classes
    const classesContainer = document.getElementById('settingsClassesContainer');
    classesContainer.innerHTML = '';

    // Add class fields for each class
    project.classes.forEach((className, index) => {
        // Use custom color if available, otherwise use default color
        const color = project.classColors && project.classColors[index] 
            ? project.classColors[index] 
            : getColorForClass(index);

        const classItem = createSettingsClassField(className, color);
        classesContainer.appendChild(classItem);
    });

    // Store project ID in a data attribute for later use
    document.getElementById('saveProjectSettingsBtn').dataset.projectId = project.id;

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('projectSettingsModal'));
    modal.show();
}

// Function to create a class field for settings
function createSettingsClassField(className = '', color = '#FF0000') {
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

// Function to add a new class field to settings
function addSettingsClassField() {
    const classesContainer = document.getElementById('settingsClassesContainer');
    const classItem = createSettingsClassField();
    classesContainer.appendChild(classItem);
}

// Function to get color for class
function getColorForClass(classIndex) {
    // Default colors
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

// Upload variables
let pendingUploads = {}; // Map of task_id to upload info
let isUploading = false; // Global flag to indicate if any uploads are in progress
let maxConcurrentUploads = 3; // Allow multiple concurrent uploads
// Track which tasks have been counted to prevent double-counting
let countedTasks = {};

// Project-specific upload variables
let projectUploadQueues = {}; // Map of projectId to upload queue
let projectUploadInProgress = {}; // Map of projectId to boolean indicating if an upload is in progress
let currentUploadInProgress = {}; // Map of projectId to boolean indicating if a file is currently being uploaded
let projectTotalFiles = {}; // Map of projectId to total files to upload
let projectCompletedUploads = {}; // Map of projectId to completed uploads
let projectFailedUploads = {}; // Map of projectId to failed uploads
let projectFailedQueues = {}; // Map of projectId to failed uploads queue
let projectLastProgressValues = {}; // Map of projectId to last progress value
// Maximum number of retry attempts
let maxRetryAttempts = 3;
// Rate limiting variables
let lastUploadTimestamp = 0;
let uploadRateLimit = 2; // Maximum 2 files per second
// Throttling for project count updates
let lastCountUpdateTimestamp = {};
let countUpdateThrottleTime = 10000; // Minimum 10 seconds between count updates for the same project
// Track update intervals to prevent multiple intervals
let projectUpdateIntervals = {};

// Socket.IO connection
let socket = null;

// Function to handle image upload
function handleImageUpload(event, projectId, uploadCard) {
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

    // Show progress container
    const progressContainer = uploadCard.querySelector('.upload-progress-container');
    progressContainer.style.display = 'block';

    // Add files to the upload queue
    addFilesToUploadQueue(imageFiles, projectId, uploadCard);
}

// Function to handle folder upload
function handleFolderUpload(event, projectId, uploadCard) {
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

    // Show progress container
    const progressContainer = uploadCard.querySelector('.upload-progress-container');
    progressContainer.style.display = 'block';

    // Add files to the upload queue
    addFilesToUploadQueue(imageFiles, projectId, uploadCard);
}

// Function to log upload queue status for monitoring
function logUploadQueueStatus() {
    if (isUploading) {
        const activeUploads = Object.values(pendingUploads).filter(
            upload => upload.status === 'queued' || upload.status === 'processing'
        ).length;

        // Log overall status
        console.log(`Overall Upload Status:
            - Active uploads: ${activeUploads}/${maxConcurrentUploads}
            - Upload rate limit: ${uploadRateLimit} files/second`);

        // Log status for each project
        Object.keys(projectUploadQueues).forEach(projectId => {
            if (projectUploadQueues[projectId].length > 0 || 
                (projectCompletedUploads[projectId] || 0) > 0 || 
                (projectFailedUploads[projectId] || 0) > 0) {

                const totalFiles = projectTotalFiles[projectId] || 0;
                const completed = projectCompletedUploads[projectId] || 0;
                const failed = projectFailedUploads[projectId] || 0;
                const progress = totalFiles > 0 ? Math.round((completed + failed) / totalFiles * 100) : 0;

                console.log(`Project ${projectId} Upload Status:
                    - Queue length: ${projectUploadQueues[projectId].length}
                    - Completed: ${completed}
                    - Failed: ${failed}
                    - Failed queue length: ${projectFailedQueues[projectId]?.length || 0}
                    - Total to upload: ${totalFiles}
                    - Progress: ${progress}%`);
            }
        });

        // Schedule next status log
        setTimeout(logUploadQueueStatus, 10000); // Log every 10 seconds
    }
}

// Function to add files to the upload queue
function addFilesToUploadQueue(files, projectId, uploadCard) {
    // Initialize project-specific variables if they don't exist
    if (!projectUploadQueues[projectId]) {
        projectUploadQueues[projectId] = [];
    }
    if (!projectFailedQueues[projectId]) {
        projectFailedQueues[projectId] = [];
    }

    // Reset project-specific counters
    projectCompletedUploads[projectId] = 0;
    projectFailedUploads[projectId] = 0;

    // Reset progress tracking
    projectLastProgressValues[projectId] = 0;

    // Reset counted tasks to prevent double-counting
    countedTasks = {};

    // Reset rate limiting timestamp
    lastUploadTimestamp = Date.now();

    // Start monitoring the upload queue
    logUploadQueueStatus();

    // Filter valid image files
    const validFiles = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Skip non-image files
        if (!file.type.startsWith('image/') && 
            !/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(file.name)) {
            continue;
        }

        validFiles.push(file);
    }

    // Set total files to upload for this project
    projectTotalFiles[projectId] = validFiles.length;

    // Process files in smaller batches to reduce memory usage
    const batchSize = 5; // Process 5 files at a time
    let currentBatch = 0;

    function addBatchToQueue() {
        const startIdx = currentBatch * batchSize;
        const endIdx = Math.min(startIdx + batchSize, validFiles.length);

        // Add this batch of files to the project-specific queue
        for (let i = startIdx; i < endIdx; i++) {
            projectUploadQueues[projectId].push({
                file: validFiles[i],
                projectId: projectId,
                uploadCard: uploadCard
            });
        }

        // If we have more files to process, schedule the next batch
        currentBatch++;
        if (currentBatch * batchSize < validFiles.length) {
            setTimeout(addBatchToQueue, 500); // Add next batch after 500ms
        }
    }

    // Start adding files in batches
    addBatchToQueue();

    // Update status
    const statusElement = uploadCard.querySelector('.upload-status');
    statusElement.textContent = `Uploaded 0/${projectTotalFiles[projectId]} files`;

    // Update progress bar to show 0%
    const progressBar = uploadCard.querySelector('.progress-bar');
    progressBar.style.width = '0%';
    progressBar.setAttribute('aria-valuenow', 0);
    progressBar.textContent = '0%';

    // Start processing the queue for this project
    processUploadQueue(projectId);
}

// Track stalled uploads
let stalledUploads = {};
let uploadTimeouts = {};

// Function to retry failed uploads for all projects
function retryFailedUploads() {
    // Check if any project has failed uploads
    let hasFailedUploads = false;
    Object.keys(projectFailedQueues).forEach(projectId => {
        if (projectFailedQueues[projectId] && projectFailedQueues[projectId].length > 0) {
            hasFailedUploads = true;
            retryFailedUploadsForProject(projectId);
        }
    });

    if (!hasFailedUploads) {
        console.log("No failed uploads to retry in any project");
    }
}

// Function to retry failed uploads for a specific project
function retryFailedUploadsForProject(projectId) {
    // Initialize project failed queue if it doesn't exist
    if (!projectFailedQueues[projectId]) {
        projectFailedQueues[projectId] = [];
    }

    if (projectFailedQueues[projectId].length === 0) {
        console.log(`No failed uploads to retry for project ${projectId}`);
        return;
    }

    console.log(`Retrying ${projectFailedQueues[projectId].length} failed uploads for project ${projectId}`);

    // Process each failed upload
    const uploadsToRetry = [...projectFailedQueues[projectId]]; // Create a copy to avoid modification during iteration
    projectFailedQueues[projectId] = []; // Clear the queue

    // Add each failed upload back to the project queue with retry count incremented
    uploadsToRetry.forEach(failedUpload => {
        // Check if we have the file object
        if (failedUpload.file) {
            console.log(`Requeuing failed upload: ${failedUpload.file.name}, attempt: ${failedUpload.retryCount + 1}/${maxRetryAttempts}`);

            // Only retry if we haven't exceeded the maximum retry attempts
            if (failedUpload.retryCount < maxRetryAttempts) {
                // Increment retry count
                failedUpload.retryCount++;

                // Add back to the project upload queue
                if (!projectUploadQueues[projectId]) {
                    projectUploadQueues[projectId] = [];
                }
                projectUploadQueues[projectId].push(failedUpload);

                // Update status text if we have the upload card
                if (failedUpload.uploadCard) {
                    const statusElement = failedUpload.uploadCard.querySelector('.upload-status');
                    if (statusElement) {
                        statusElement.textContent = `Uploaded ${projectCompletedUploads[projectId] || 0}/${projectTotalFiles[projectId] || 0} files`;
                    }
                }
            } else {
                console.warn(`Upload of ${failedUpload && failedUpload.file ? failedUpload.file.name : 'unknown file'} failed after ${maxRetryAttempts} attempts`);
                // Count as permanently failed for this project
                projectFailedUploads[projectId] = (projectFailedUploads[projectId] || 0) + 1;
            }
        } else if (failedUpload && failedUpload.fileMetadata) {
            // We don't have the file object, just the metadata
            console.warn(`Cannot retry upload of ${failedUpload.fileMetadata.name} - file object is no longer available`);
            // Count as permanently failed for this project
            projectFailedUploads[projectId] = (projectFailedUploads[projectId] || 0) + 1;
        }
    });

    // Start processing the queue if not already processing
    if (!projectUploadInProgress[projectId] && projectUploadQueues[projectId] && projectUploadQueues[projectId].length > 0) {
        processUploadQueue(projectId);
    }
}

// Function to process the next item in the queue with a 0.3-second delay
function processNextItemWithDelay(projectId) {
    // Reset the flag to indicate no upload is in progress for this project
    projectUploadInProgress[projectId] = false;

    // Always wait 0.3 seconds before processing the next item
    console.log(`Waiting 0.3 seconds before processing next item in queue for project ${projectId}`);
    setTimeout(() => processUploadQueue(projectId), 300);
}

// Function to process the upload queue for all projects
function processUploadQueue(specificProjectId = null) {
    // Always wait 0.3 seconds between uploads
    const now = Date.now();
    const timeSinceLastUpload = now - lastUploadTimestamp;
    if (timeSinceLastUpload < 300) {
        const waitTime = 300 - timeSinceLastUpload;
        console.log(`Enforcing 0.3-second delay between uploads. Waiting ${waitTime}ms...`);
        setTimeout(() => processUploadQueue(specificProjectId), waitTime);
        return;
    }

    // Update the last upload timestamp
    lastUploadTimestamp = now;

    // Clean up memory by removing references to completed uploads
    for (const taskId in pendingUploads) {
        if (pendingUploads[taskId].status === 'completed') {
            // Remove the file reference to free up memory
            if (pendingUploads[taskId].file) {
                delete pendingUploads[taskId].file;
            }

            // Also remove any other large objects that aren't needed anymore
            // but keep only the essential metadata
            const essentialData = {
                filename: pendingUploads[taskId].filename,
                status: pendingUploads[taskId].status,
                progress: pendingUploads[taskId].progress || 100,
                projectId: pendingUploads[taskId].projectId,
                created: pendingUploads[taskId].created,
                // Don't keep fileMetadata for completed uploads to save memory
                task_id: taskId
            };

            // Replace the full object with just the essential data
            pendingUploads[taskId] = essentialData;
        }
    }

    // If a specific project was requested, process only that project
    if (specificProjectId) {
        processProjectQueue(specificProjectId);
        return;
    }

    // Process all project queues
    let anyProjectUploading = false;
    Object.keys(projectUploadQueues).forEach(projectId => {
        if (processProjectQueue(projectId)) {
            anyProjectUploading = true;
        }
    });

    // Update global uploading flag
    isUploading = anyProjectUploading;
}

// Function to process the upload queue for a specific project
function processProjectQueue(projectId) {
    // Initialize project variables if they don't exist
    if (!projectUploadQueues[projectId]) {
        projectUploadQueues[projectId] = [];
    }
    if (!projectFailedQueues[projectId]) {
        projectFailedQueues[projectId] = [];
    }
    if (projectUploadInProgress[projectId] === undefined) {
        projectUploadInProgress[projectId] = false;
    }
    if (projectCompletedUploads[projectId] === undefined) {
        projectCompletedUploads[projectId] = 0;
    }
    if (projectFailedUploads[projectId] === undefined) {
        projectFailedUploads[projectId] = 0;
    }

    // Check for any stalled uploads for this project
    const stalledTaskIds = Object.keys(stalledUploads).filter(
        taskId => stalledUploads[taskId].projectId === projectId
    );

    if (stalledTaskIds.length > 0) {
        console.warn(`Detected ${stalledTaskIds.length} stalled uploads for project ${projectId}. Attempting to recover...`);

        // Mark stalled uploads as failed and add them to retry queue
        stalledTaskIds.forEach(taskId => {
            if (pendingUploads[taskId]) {
                console.warn(`Marking stalled upload ${taskId} as failed`);
                pendingUploads[taskId].status = 'failed';
                pendingUploads[taskId].error = 'Upload timed out';

                // Add to failed uploads queue for retry if we have the file metadata
                if (pendingUploads[taskId] && pendingUploads[taskId].fileMetadata) {
                    // We need to prompt the user to reselect the file since we don't store the full file object
                    console.log(`Upload of ${pendingUploads[taskId].filename} failed. Please try again.`);
                }

                // Increment failed uploads counter for this project
                projectFailedUploads[projectId]++;

                // Remove from pending uploads after processing
                setTimeout(() => {
                    delete pendingUploads[taskId];
                    delete stalledUploads[taskId];
                    if (uploadTimeouts[taskId]) {
                        clearTimeout(uploadTimeouts[taskId]);
                        delete uploadTimeouts[taskId];
                    }
                    savePendingUploads(projectId);
                }, 1000);
            }
        });

        // Update UI to reflect the failed uploads
        updateUploadProgress(projectId, 0, 'failed');
    }

    // If no files in queue for this project, check for failed uploads to retry
    if (projectUploadQueues[projectId].length === 0) {
        // If we have failed uploads to retry for this project, do that now
        if (projectFailedQueues[projectId] && projectFailedQueues[projectId].length > 0) {
            retryFailedUploadsForProject(projectId);
            return true; // Still processing
        }

        // Show final status if no more uploads for this project
        const totalProcessed = (projectCompletedUploads[projectId] || 0) + (projectFailedUploads[projectId] || 0);
        const totalAttempted = projectTotalFiles[projectId] || 0;

        if (totalAttempted > 0) {
            const overallProgress = Math.round((totalProcessed / totalAttempted) * 100);

            // Find the upload card for this project
            const projectCard = document.getElementById(`project-card-${projectId}`);
            if (projectCard) {
                const statusElement = projectCard.querySelector('.upload-status');
                const progressBar = projectCard.querySelector('.progress-bar');

                if (statusElement && progressBar) {
                    // Update progress bar
                    progressBar.style.width = `${overallProgress}%`;
                    progressBar.setAttribute('aria-valuenow', overallProgress);
                    progressBar.textContent = `${overallProgress}%`;

                    // Update status text
                    statusElement.textContent = `Uploaded ${projectCompletedUploads[projectId] || 0}/${totalAttempted} files`;

                    // Log detailed upload statistics
                    console.log(`Upload session completed for project ${projectId}:
                        - Total files: ${totalAttempted}
                        - Successfully uploaded: ${projectCompletedUploads[projectId] || 0}
                        - Failed: ${projectFailedUploads[projectId] || 0}
                        - Success rate: ${Math.round(((projectCompletedUploads[projectId] || 0) / totalAttempted) * 100)}%`);

                    // Update the project image count once after uploads are completed
                    if ((projectCompletedUploads[projectId] || 0) > 0) {
                        setTimeout(() => {
                            updateProjectImageCount(projectId);
                        }, 3000);
                    }

                    // Clear any existing interval for this project
                    if (projectUpdateIntervals[projectId]) {
                        clearInterval(projectUpdateIntervals[projectId]);
                        delete projectUpdateIntervals[projectId];
                    }
                }
            }
        }

        return false; // No more processing for this project
    }

    // If a file is currently being uploaded for this project, wait and try again later
    if (projectUploadInProgress[projectId] || currentUploadInProgress[projectId]) {
        console.log(`A file is currently being uploaded for project ${projectId}. Waiting for it to complete...`);
        setTimeout(() => processUploadQueue(projectId), 1000);
        return true; // Still processing
    }

    // Set the flag to indicate an upload is in progress for this project
    projectUploadInProgress[projectId] = true;

    // Get next file from queue for this project
    const uploadItem = projectUploadQueues[projectId].shift();
    const file = uploadItem.file;
    const uploadCard = uploadItem.uploadCard;
    const retryCount = uploadItem.retryCount || 0;

    // Update status for this project
    if (uploadCard) {
        const statusElement = uploadCard.querySelector('.upload-status');
        if (statusElement) {
            statusElement.textContent = `Uploaded ${projectCompletedUploads[projectId] || 0}/${projectTotalFiles[projectId] || 0} files`;
        }
    }

    // Upload the file with retry information
    uploadFile(file, projectId, retryCount, uploadCard);

    return true; // Still processing
}

// Function to upload a single file
function uploadFile(file, projectId, retryCount = 0) {
    // Set the flag to indicate an upload is in progress for this project
    currentUploadInProgress[projectId] = true;
    // Create FormData to send the file to the server
    const formData = new FormData();
    formData.append('file', file);

    // Create a unique ID for this upload
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Store file metadata instead of the full file object to reduce memory usage
    const fileMetadata = {
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified
    };

    // Add to pending uploads with initial status
    pendingUploads[clientId] = {
        filename: file.name,
        status: 'uploading',
        progress: 0,
        projectId: projectId,
        created: new Date().toISOString(),
        fileMetadata: fileMetadata, // Store metadata instead of the full file
        retryCount: retryCount // Track retry attempts
    };

    // Save to localStorage
    savePendingUploads(projectId);

    // Update UI with initial progress
    updateUploadProgress(projectId, 0, 'uploading');

    // Set up a timeout to detect stalled uploads (30 seconds for initial upload)
    const uploadTimeout = setTimeout(() => {
        console.warn(`Upload of ${file.name} timed out at initial stage`);

        // Update status to failed
        if (pendingUploads[clientId]) {
            pendingUploads[clientId].status = 'failed';
            pendingUploads[clientId].error = 'Upload timed out';

            // Save to localStorage
            savePendingUploads(projectId);

            // Update UI
            updateUploadProgress(projectId, 0, 'failed');

            // Add to failed uploads queue for retry
            if (retryCount < maxRetryAttempts) {
                console.log(`Adding ${file.name} to retry queue (attempt ${retryCount + 1}/${maxRetryAttempts})`);
                // Store file metadata instead of the full file object
                if (!projectFailedQueues[projectId]) {
                    projectFailedQueues[projectId] = [];
                }
                projectFailedQueues[projectId].push({
                    fileMetadata: pendingUploads[clientId] && pendingUploads[clientId].fileMetadata ? pendingUploads[clientId].fileMetadata : null,
                    file: file, // Keep the file reference for immediate retry
                    projectId: projectId,
                    retryCount: retryCount
                });
            } else {
                console.warn(`Upload of ${file.name} failed after ${maxRetryAttempts} attempts`);
                // Increment failed uploads counter
                if (!projectFailedUploads[projectId]) {
                    projectFailedUploads[projectId] = 0;
                }
                projectFailedUploads[projectId]++;
            }

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[clientId];
                savePendingUploads(projectId);
            }, 5000);

            // Process next item in queue
            processUploadQueue();
        }
    }, 30000); // 30 second timeout

    // Upload the file to the server with improved error handling
    fetch(`/projects/${projectId}/upload`, {
        method: 'POST',
        body: formData
    })
    .then(response => {
        // Clear the initial upload timeout
        clearTimeout(uploadTimeout);

        if (!response.ok) {
            // Handle different HTTP error codes
            let errorMessage = 'Failed to upload image';
            if (response.status === 413) {
                errorMessage = 'File too large';
            } else if (response.status === 429) {
                errorMessage = 'Too many requests, please try again later';
            } else if (response.status >= 500) {
                errorMessage = 'Server error, please try again later';
            }
            throw new Error(errorMessage);
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
                task_id: taskId,
                projectId: projectId
            };

            // Remove client ID entry
            delete pendingUploads[clientId];

            // Save to localStorage
            savePendingUploads(projectId);

            // Update UI
            updateUploadProgress(projectId, 0, data.status || 'queued');

            // Set up a timeout to detect stalled processing (2 minutes)
            uploadTimeouts[taskId] = setTimeout(() => {
                console.warn(`Processing of ${file.name} (task ${taskId}) timed out`);

                // Mark as stalled for handling in processUploadQueue
                stalledUploads[taskId] = {
                    filename: file.name,
                    taskId: taskId,
                    projectId: projectId,
                    stalledAt: new Date().toISOString(),
                    fileMetadata: pendingUploads[taskId] && pendingUploads[taskId].fileMetadata ? pendingUploads[taskId].fileMetadata : null, // Store metadata instead of the full file, with null check
                    retryCount: retryCount // Track retry count
                };

                // Process next item in queue to keep things moving
                processUploadQueue();
            }, 120000); // 2 minute timeout

            // Start checking status
            checkUploadStatus(taskId, projectId, file, retryCount);
        } else {
            // Update status to failed
            pendingUploads[clientId].status = 'failed';
            pendingUploads[clientId].error = data.error || 'Unknown error';

            // Save to localStorage
            savePendingUploads(projectId);

            // Update UI
            updateUploadProgress(projectId, 0, 'failed');

            // Add to failed uploads queue for retry if not exceeding max retries
            if (retryCount < maxRetryAttempts) {
                console.log(`Adding ${file.name} to retry queue due to server error (attempt ${retryCount + 1}/${maxRetryAttempts})`);
                if (!projectFailedQueues[projectId]) {
                    projectFailedQueues[projectId] = [];
                }
                projectFailedQueues[projectId].push({
                    fileMetadata: pendingUploads[clientId] && pendingUploads[clientId].fileMetadata ? pendingUploads[clientId].fileMetadata : null,
                    file: file, // Keep the file reference for immediate retry
                    projectId: projectId,
                    retryCount: retryCount
                });
            } else {
                console.warn(`Upload of ${file.name} failed after ${maxRetryAttempts} attempts`);
                // Increment failed uploads counter
                if (!projectFailedUploads[projectId]) {
                    projectFailedUploads[projectId] = 0;
                }
                projectFailedUploads[projectId]++;
            }

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[clientId];
                savePendingUploads(projectId);
            }, 5000);

            // Process next item in queue
            processUploadQueue();
        }
    })
    .catch(error => {
        // Clear the initial upload timeout
        clearTimeout(uploadTimeout);

        console.error('Error uploading image:', error);

        // Update status to failed
        pendingUploads[clientId].status = 'failed';
        pendingUploads[clientId].error = error.message || 'Network error';

        // Save to localStorage
        savePendingUploads(projectId);

        // Update UI
        updateUploadProgress(projectId, 0, 'failed');

        // Add to failed uploads queue for retry if not exceeding max retries
        if (retryCount < maxRetryAttempts) {
            console.log(`Adding ${file.name} to retry queue due to network error (attempt ${retryCount + 1}/${maxRetryAttempts})`);
            if (!projectFailedQueues[projectId]) {
                projectFailedQueues[projectId] = [];
            }
            projectFailedQueues[projectId].push({
                file: file,
                projectId: projectId,
                retryCount: retryCount
            });
        } else {
            console.warn(`Upload of ${file.name} failed after ${maxRetryAttempts} attempts`);
            // Increment failed uploads counter
            if (!projectFailedUploads[projectId]) {
                projectFailedUploads[projectId] = 0;
            }
            projectFailedUploads[projectId]++;
        }

        // Remove from pending uploads after a delay
        setTimeout(() => {
            delete pendingUploads[clientId];
            savePendingUploads(projectId);
        }, 5000);

        // Reset the flag to indicate no upload is in progress for this project
        currentUploadInProgress[projectId] = false;

        // Process next item in queue
        processUploadQueue();
    });
}

// Function to check upload status
// This is now primarily a fallback mechanism since we're using WebSockets for real-time updates
// It's still useful for initial status check and as a fallback if WebSocket connection fails
function checkUploadStatus(taskId, projectId, originalFile = null, retryCount = 0) {
    // Add logging for debugging
    console.log(`Checking status of task ${taskId} for project ${projectId}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetryAttempts})` : ''}`);

    fetch(`/projects/${projectId}/upload/status/${taskId}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to get upload status');
            }
            return response.json();
        })
        .then(data => {
            // Update pending uploads with latest status
            if (pendingUploads[taskId]) {
                pendingUploads[taskId].status = data.status;
                pendingUploads[taskId].progress = data.progress;
                pendingUploads[taskId].projectId = projectId;
                pendingUploads[taskId].lastUpdated = new Date().toISOString();

                if (data.error) {
                    pendingUploads[taskId].error = data.error;
                }

                // Save to localStorage
                savePendingUploads(projectId);
            }

            // Update UI
            updateUploadProgress(projectId, data.progress, data.status, data.error);

            // If still processing, check again after a delay
            if (data.status === 'queued' || data.status === 'processing') {
                // Remove from stalled uploads if it was marked as stalled
                if (stalledUploads[taskId]) {
                    console.log(`Task ${taskId} is responding again, removing from stalled uploads`);
                    delete stalledUploads[taskId];
                }

                // Always check once per second as per requirements
                const fixedDelay = 1000; // Fixed 1 second delay between status checks

                console.log(`Task ${taskId}: checking status every ${fixedDelay/1000}s as per requirements`);

                // Check again after the fixed delay
                setTimeout(() => checkUploadStatus(taskId, projectId), fixedDelay);
            } else {
                // If completed or failed, clear any timeouts and process next item
                if (uploadTimeouts[taskId]) {
                    clearTimeout(uploadTimeouts[taskId]);
                    delete uploadTimeouts[taskId];
                }

                // Remove from stalled uploads if it was marked as stalled
                if (stalledUploads[taskId]) {
                    delete stalledUploads[taskId];
                }

                if (data.status === 'completed') {
                    console.log(`Task ${taskId} completed successfully`);

                    // Increment completed uploads counter only if not already counted
                    if (!countedTasks[taskId]) {
                        if (!projectCompletedUploads[projectId]) {
                            projectCompletedUploads[projectId] = 0;
                        }
                        projectCompletedUploads[projectId]++;
                        countedTasks[taskId] = true;
                    }

                    // Update UI with 100% progress
                    updateUploadProgress(projectId, 100, 'completed');

                    // Reset the flag to indicate no upload is in progress for this project
                    currentUploadInProgress[projectId] = false;

                    // We'll update the image count only at the end of the upload process
                    // to ensure we show the real number of files in the project
                } else if (data.status === 'failed') {
                    console.warn(`Task ${taskId} failed: ${data.error || 'Unknown error'}`);

                    // Add to failed uploads queue for retry if we have the original file and haven't exceeded max retries
                    if (originalFile && retryCount < maxRetryAttempts) {
                        console.log(`Adding ${originalFile.name} to retry queue (attempt ${retryCount + 1}/${maxRetryAttempts})`);

                        // Create file metadata if we have the original file
                        const fileMetadata = {
                            name: originalFile.name,
                            size: originalFile.size,
                            type: originalFile.type,
                            lastModified: originalFile.lastModified
                        };

                        if (!projectFailedQueues[projectId]) {
                            projectFailedQueues[projectId] = [];
                        }
                        projectFailedQueues[projectId].push({
                            file: originalFile, // Keep the file reference for immediate retry
                            fileMetadata: fileMetadata, // Store metadata for persistence
                            projectId: projectId,
                            retryCount: retryCount
                        });

                        // Update UI
                        updateUploadProgress(projectId, 0, 'failed');
                    } else {
                        // Increment failed uploads counter only if we're not going to retry
                        if (!projectFailedUploads[projectId]) {
                            projectFailedUploads[projectId] = 0;
                        }
                        projectFailedUploads[projectId]++;

                        // Update UI
                        updateUploadProgress(projectId, 0, 'failed');
                    }

                    // Reset the flag to indicate no upload is in progress for this project
                    currentUploadInProgress[projectId] = false;
                }

                // Remove from pending uploads after a delay
                setTimeout(() => {
                    delete pendingUploads[taskId];
                    // Save to localStorage
                    savePendingUploads(projectId);
                }, 5000);

                // Process next item in queue with delay
                processNextItemWithDelay(projectId);
            }
        })
        .catch(error => {
            console.error(`Error checking upload status for task ${taskId}:`, error);

            // Check if this task is already marked as stalled
            if (!stalledUploads[taskId]) {
                // If we can't get the status a few times, we'll consider it stalled
                // but we'll keep trying for a while before giving up completely
                const checkAttempts = pendingUploads[taskId]?.checkAttempts || 0;

                if (checkAttempts < 5) {
                    // Increment check attempts
                    if (pendingUploads[taskId]) {
                        pendingUploads[taskId].checkAttempts = checkAttempts + 1;
                        pendingUploads[taskId].lastError = error.message;

                        // Save to localStorage
                        savePendingUploads(projectId);

                        // Try again after a delay with exponential backoff
                        const delay = Math.min(5000 * Math.pow(2, checkAttempts), 30000);
                        console.log(`Will retry checking task ${taskId} in ${delay}ms (attempt ${checkAttempts + 1})`);
                        setTimeout(() => checkUploadStatus(taskId, projectId, originalFile, retryCount), delay);
                        return;
                    }
                } else {
                    // After several failed attempts, mark as stalled
                    console.warn(`Task ${taskId} is not responding after ${checkAttempts} attempts, marking as stalled`);
                    stalledUploads[taskId] = {
                        filename: pendingUploads[taskId]?.filename || 'Unknown file',
                        taskId: taskId,
                        projectId: projectId,
                        stalledAt: new Date().toISOString(),
                        error: error.message,
                        originalFile: originalFile, // Store original file for retry
                        retryCount: retryCount // Track retry count
                    };
                }
            }

            // Update status to failed
            if (pendingUploads[taskId]) {
                pendingUploads[taskId].status = 'failed';
                pendingUploads[taskId].error = 'Failed to get upload status';
                pendingUploads[taskId].projectId = projectId;

                // Save to localStorage
                savePendingUploads(projectId);
            }

            // Add to failed uploads queue for retry if we have the original file and haven't exceeded max retries
            if (originalFile && retryCount < maxRetryAttempts) {
                console.log(`Adding ${originalFile.name} to retry queue due to status check failure (attempt ${retryCount + 1}/${maxRetryAttempts})`);
                if (!projectFailedQueues[projectId]) {
                    projectFailedQueues[projectId] = [];
                }
                projectFailedQueues[projectId].push({
                    file: originalFile,
                    projectId: projectId,
                    retryCount: retryCount
                });

                // Update UI
                updateUploadProgress(projectId, 0, 'failed');
            } else {
                // Increment failed uploads counter only if we're not going to retry
                if (!projectFailedUploads[projectId]) {
                    projectFailedUploads[projectId] = 0;
                }
                projectFailedUploads[projectId]++;

                // Update UI
                updateUploadProgress(projectId, 0, 'failed');
            }

            // Clear any timeouts
            if (uploadTimeouts[taskId]) {
                clearTimeout(uploadTimeouts[taskId]);
                delete uploadTimeouts[taskId];
            }

            // Remove from pending uploads after a delay
            setTimeout(() => {
                delete pendingUploads[taskId];
                delete stalledUploads[taskId];
                // Save to localStorage
                savePendingUploads(projectId);
            }, 5000);

            // Process next item in queue
            processUploadQueue();
        });
}

// Function to load all pending uploads for all projects (from IndexedDB with localStorage fallback)
function loadAllPendingUploads() {
    try {
        // First try to use IndexedDB if available
        if (window.uploadsDB) {
            // Since we don't have a direct method to get all project IDs from IndexedDB,
            // we'll use a workaround by checking for known project IDs or loading from localStorage first

            // Try to load from localStorage to get project IDs
            const projectIds = new Set();

            // Get project IDs from localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('pendingUploads_')) {
                    const projectId = key.replace('pendingUploads_', '');
                    projectIds.add(projectId);
                }
            }

            // Also check for any project cards in the DOM to get additional project IDs
            document.querySelectorAll('[id^="project-card-"]').forEach(card => {
                const projectId = card.id.replace('project-card-', '');
                if (projectId) {
                    projectIds.add(projectId);
                }
            });

            // Load each project's uploads
            projectIds.forEach(projectId => {
                loadPendingUploads(projectId);
            });
        } else {
            // Fallback to localStorage only
            loadAllPendingUploadsFromLocalStorage();
        }
    } catch (error) {
        console.error('Error loading all pending uploads:', error);
        // Fallback to localStorage
        loadAllPendingUploadsFromLocalStorage();
    }
}

// Helper function to load all pending uploads from localStorage
function loadAllPendingUploadsFromLocalStorage() {
    try {
        // Get all localStorage keys
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            // Check if key is a pendingUploads key
            if (key && key.startsWith('pendingUploads_')) {
                const projectId = key.replace('pendingUploads_', '');
                loadPendingUploads(projectId);
            }
        }
    } catch (error) {
        console.error('Error loading all pending uploads from localStorage:', error);
    }
}

// Function to load pending uploads for a specific project (from IndexedDB with localStorage fallback)
function loadPendingUploads(projectId) {
    try {
        // Try to load from IndexedDB first
        if (window.uploadsDB) {
            window.uploadsDB.loadPendingUploads(projectId)
                .then(projectUploads => {
                    if (Object.keys(projectUploads).length > 0) {
                        // Process the uploads loaded from IndexedDB
                        processLoadedUploads(projectId, projectUploads);
                    } else {
                        // If no data in IndexedDB, try localStorage as fallback
                        loadFromLocalStorageFallback(projectId);
                    }
                })
                .catch(error => {
                    console.error(`Error loading from IndexedDB for project ${projectId}:`, error);
                    // Fall back to localStorage
                    loadFromLocalStorageFallback(projectId);
                });
        } else {
            // If IndexedDB is not available, use localStorage
            loadFromLocalStorageFallback(projectId);
        }
    } catch (error) {
        console.error(`Error in loadPendingUploads for project ${projectId}:`, error);
        // Try localStorage as last resort
        loadFromLocalStorageFallback(projectId);
    }
}

// Helper function to load from localStorage as fallback
function loadFromLocalStorageFallback(projectId) {
    try {
        const savedUploads = localStorage.getItem(`pendingUploads_${projectId}`);
        if (savedUploads) {
            const projectUploads = JSON.parse(savedUploads);
            processLoadedUploads(projectId, projectUploads);
        }
    } catch (error) {
        console.error(`Error loading from localStorage for project ${projectId}:`, error);
    }
}

// Helper function to process loaded uploads
function processLoadedUploads(projectId, projectUploads) {
    // Find the project card
    const projectCard = document.getElementById(`project-card-${projectId}`);
    if (projectCard) {
        // Show progress container
        const progressContainer = projectCard.querySelector('.upload-progress-container');
        if (progressContainer) {
            progressContainer.style.display = 'block';
        }

        // Set current project and card for uploads
        currentProjectId = projectId;
        currentUploadCard = projectCard;

        // Merge with existing pendingUploads
        Object.keys(projectUploads).forEach(taskId => {
            pendingUploads[taskId] = projectUploads[taskId];
            // Check status of each pending upload
            checkUploadStatus(taskId, projectId);
        });

        // Set uploading flag if there are pending uploads
        if (Object.keys(pendingUploads).length > 0) {
            isUploading = true;

            // Count completed and failed uploads
            let completed = 0;
            let failed = 0;
            let inProgress = 0;
            let total = Object.keys(projectUploads).length;

            Object.values(projectUploads).forEach(upload => {
                if (upload.status === 'completed') {
                    completed++;
                } else if (upload.status === 'failed') {
                    failed++;
                } else {
                    inProgress++;
                }
            });

            // Update counters
            completedUploads = completed;
            failedUploads = failed;
            totalFilesToUpload = Math.max(total, completed + failed + inProgress);

            // Update progress bar and status text
            const progressBar = projectCard.querySelector('.progress-bar');
            const statusElement = projectCard.querySelector('.upload-status');

            if (progressBar && statusElement) {
                // Calculate overall progress
                const overallProgress = Math.round((completed + failed) / totalFilesToUpload * 100);

                // Update progress bar
                progressBar.style.width = `${overallProgress}%`;
                progressBar.setAttribute('aria-valuenow', overallProgress);
                progressBar.textContent = `${overallProgress}%`;

                // Update status text
                statusElement.textContent = `Uploaded ${completed}/${totalFilesToUpload} files`;

                console.log(`Restored upload progress: ${completed}/${totalFilesToUpload} files (${overallProgress}%)`);
            }

            // Update the project image count once when loading pending uploads
            if (projectId) {
                updateProjectImageCount(projectId);
            }

            // Clear any existing interval for this project
            if (projectUpdateIntervals[projectId]) {
                clearInterval(projectUpdateIntervals[projectId]);
                delete projectUpdateIntervals[projectId];
            }
        }
    }
}

// Function to save pending uploads to IndexedDB (with localStorage fallback)
function savePendingUploads(projectId) {
    if (!projectId) return;
    let projectUploads = {};
    try {
        // Filter uploads for this project
        Object.keys(pendingUploads).forEach(taskId => {
            if (pendingUploads[taskId].projectId === projectId) {
                // Create a copy without the file object to reduce size
                const uploadInfo = { ...pendingUploads[taskId] };

                // Remove the file object if it exists (it's not needed in storage)
                if (uploadInfo.file) {
                    delete uploadInfo.file;
                }

                // Remove fileMetadata for completed uploads to save space
                if (uploadInfo.status === 'completed' && uploadInfo.fileMetadata) {
                    delete uploadInfo.fileMetadata;
                }

                // Store only essential data
                projectUploads[taskId] = uploadInfo;
            }
        });

        // Limit the number of uploads stored to prevent quota issues
        const maxUploadsToStore = 100; // Adjust as needed
        const taskIds = Object.keys(projectUploads);

        if (taskIds.length > maxUploadsToStore) {
            console.warn(`Too many uploads to store (${taskIds.length}), limiting to ${maxUploadsToStore}`);

            // Sort by creation time (newest first) if available
            taskIds.sort((a, b) => {
                const timeA = projectUploads[a].created ? new Date(projectUploads[a].created).getTime() : 0;
                const timeB = projectUploads[b].created ? new Date(projectUploads[b].created).getTime() : 0;
                return timeB - timeA; // Newest first
            });

            // Keep only the newest uploads
            const limitedUploads = {};
            taskIds.slice(0, maxUploadsToStore).forEach(taskId => {
                limitedUploads[taskId] = projectUploads[taskId];
            });

            projectUploads = limitedUploads;
        }

        // Try to save to IndexedDB
        if (window.uploadsDB) {
            // Use IndexedDB if available
            window.uploadsDB.savePendingUploads(projectId, projectUploads)
                .then(() => {
                    console.log(`Successfully saved uploads to IndexedDB for project ${projectId}`);
                })
                .catch(error => {
                    console.error(`Error saving to IndexedDB for project ${projectId}:`, error);
                    // Fall back to localStorage with reduced data
                    saveToLocalStorageFallback(projectId, projectUploads, taskIds);
                });
        } else {
            // Fall back to localStorage if IndexedDB is not available
            console.warn('IndexedDB not available, falling back to localStorage');
            saveToLocalStorageFallback(projectId, projectUploads, taskIds);
        }
    } catch (error) {
        console.error(`Error preparing uploads for project ${projectId}:`, error);
    }
}

// Helper function for localStorage fallback
function saveToLocalStorageFallback(projectId, projectUploads, taskIds) {
    try {
        const serializedData = JSON.stringify(projectUploads);

        // Check size before attempting to save
        const estimatedSize = serializedData.length * 2; // Rough estimate: 2 bytes per character
        if (estimatedSize > 4 * 1024 * 1024) { // 4MB limit (most browsers have 5-10MB)
            console.warn(`Data too large for localStorage (${Math.round(estimatedSize/1024/1024)}MB), reducing...`);

            // Further reduce by removing non-essential fields
            Object.keys(projectUploads).forEach(taskId => {
                // Remove fileMetadata for all uploads to save space
                if (projectUploads[taskId].fileMetadata) {
                    delete projectUploads[taskId].fileMetadata;
                }

                // Keep only the most essential fields
                const minimalInfo = {
                    filename: projectUploads[taskId].filename,
                    status: projectUploads[taskId].status,
                    projectId: projectId,
                    created: projectUploads[taskId].created
                };
                projectUploads[taskId] = minimalInfo;
            });

            // Try again with reduced data
            try {
                localStorage.setItem(`pendingUploads_${projectId}`, JSON.stringify(projectUploads));
            } catch (innerError) {
                // If still too large, try with even fewer uploads
                console.warn(`Still too large, reducing number of uploads stored...`);
                const reducedUploads = {};
                const reducedTaskIds = taskIds.slice(0, Math.floor(taskIds.length / 2)); // Store only half
                reducedTaskIds.forEach(taskId => {
                    reducedUploads[taskId] = projectUploads[taskId];
                });
                localStorage.setItem(`pendingUploads_${projectId}`, JSON.stringify(reducedUploads));
            }
        } else {
            // Save the original data if it's not too large
            localStorage.setItem(`pendingUploads_${projectId}`, serializedData);
        }
    } catch (storageError) {
        console.error(`localStorage quota exceeded for project ${projectId}:`, storageError);

        // If quota is exceeded, try to save minimal data
        try {
            // Create a minimal version with just task IDs and status
            const minimalUploads = {};
            // Only include the most recent 50 uploads
            const recentTaskIds = taskIds.slice(0, 50);
            recentTaskIds.forEach(taskId => {
                minimalUploads[taskId] = {
                    status: projectUploads[taskId].status || 'unknown',
                    projectId: projectId
                };
            });

            localStorage.setItem(`pendingUploads_${projectId}`, JSON.stringify(minimalUploads));
            console.log(`Saved minimal upload data for project ${projectId}`);
        } catch (finalError) {
            // If all else fails, try to clear localStorage for this project
            console.error(`Failed to save even minimal data, clearing storage for project ${projectId}:`, finalError);
            try {
                localStorage.removeItem(`pendingUploads_${projectId}`);
            } catch (e) {
                // Nothing more we can do
            }
        }
    }
}

// Function to update the upload progress in the UI
function updateUploadProgress(projectId, progress, status, error) {
    // Find the project card
    const projectCard = document.getElementById(`project-card-${projectId}`);
    if (!projectCard) return;

    const progressBar = projectCard.querySelector('.progress-bar');
    const statusElement = projectCard.querySelector('.upload-status');
    const progressContainer = projectCard.querySelector('.upload-progress-container');

    // Ensure the progress container is visible
    if (progressContainer) {
        progressContainer.style.display = 'block';
    }

    // Calculate overall progress with current file's progress factored in
    const totalProcessed = (projectCompletedUploads[projectId] || 0) + (projectFailedUploads[projectId] || 0);
    const totalToProcess = Math.max(
        projectTotalFiles[projectId] || 0, 
        totalProcessed + (projectFailedQueues[projectId]?.length || 0) + (projectUploadQueues[projectId]?.length || 0)
    );

    // Calculate the base progress from completed and failed files
    let baseProgress = totalToProcess > 0 ? (totalProcessed / totalToProcess) * 100 : 0;

    // Add the contribution of the current file's progress
    // Current file contributes (1/totalToProcess) of the total progress
    let currentFileContribution = 0;
    if (totalToProcess > 0 && status !== 'completed' && status !== 'failed') {
        // Weight the current file's progress by its contribution to the total
        currentFileContribution = (progress / 100) * (1 / totalToProcess) * 100;
    }

    // Calculate the overall progress
    let overallProgress = Math.min(100, baseProgress + currentFileContribution);

    // Round to 1 decimal place for smoother updates
    overallProgress = Math.round(overallProgress * 10) / 10;

    // Store the last progress value to prevent going backwards
    if (!projectLastProgressValues[projectId]) {
        projectLastProgressValues[projectId] = 0;
    }

    // Ensure progress never goes backwards (only increases or stays the same)
    if (overallProgress < projectLastProgressValues[projectId]) {
        overallProgress = projectLastProgressValues[projectId];
    } else {
        projectLastProgressValues[projectId] = overallProgress;
    }

    // Round for display
    const displayProgress = Math.round(overallProgress);

    // Update the progress bar with overall progress
    progressBar.style.width = `${overallProgress}%`;
    progressBar.setAttribute('aria-valuenow', displayProgress);
    progressBar.textContent = `${displayProgress}%`;

    // Display only the total number of photos and how many have been loaded, in one line
    let statusText = `Uploaded ${projectCompletedUploads[projectId] || 0}/${totalToProcess} files`;

    statusElement.textContent = statusText;

    // We'll update the image count only at the end of the upload process
    // to ensure we show the real number of files in the project
}

// Function to update project image count and annotations count
function updateProjectImageCount(projectId) {
    // Find the project card
    const projectCard = document.getElementById(`project-card-${projectId}`);
    if (!projectCard) {
        console.error(`Project card not found for project ${projectId}`);
        return;
    }

    // Apply throttling to prevent too frequent updates
    const now = Date.now();
    if (lastCountUpdateTimestamp[projectId] && (now - lastCountUpdateTimestamp[projectId] < countUpdateThrottleTime)) {
        console.log(`Throttling count update for project ${projectId} - last update was ${(now - lastCountUpdateTimestamp[projectId])/1000}s ago`);
        return;
    }

    // Update the timestamp for this project
    lastCountUpdateTimestamp[projectId] = now;

    // Check if we're currently uploading to this project
    const isCurrentlyUploading = isUploading && currentProjectId === projectId;

    // Track retry attempts
    let retryCount = 0;
    const maxRetries = 3;
    const initialBackoff = 1000; // 1 second

    // Function to fetch counts with retry logic
    function fetchCountsWithRetry(backoff) {
        // Use the lightweight counts endpoint instead of full project details
        fetch(`/projects/${projectId}/counts`)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to get project counts: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                // Always use the server's imageCount to ensure we show the real number of files in the project
                let imageCount = data.imageCount !== undefined ? data.imageCount : 0;
                console.log(`Using server image count: ${imageCount}`);

                // If we're at the end of an upload process, log the difference between local and server counts
                if (isCurrentlyUploading && projectCompletedUploads[projectId] !== imageCount) {
                    console.log(`Note: Local count (${projectCompletedUploads[projectId] || 0}) differs from server count (${imageCount})`);
                }

                // Find the image count element and update it
                const imageCountElement = projectCard.querySelector('.image-count');
                if (imageCountElement) {
                    // Update the image count and remove the loading class if present
                    imageCountElement.textContent = imageCount;
                    imageCountElement.classList.remove('loading-count');
                }

                // Update annotation counts
                if (data.annotationsCount) {
                    const annotationStatsElement = projectCard.querySelector('.annotation-stats');
                    if (annotationStatsElement) {
                        // If we have annotation counts, update them
                        if (Object.keys(data.annotationsCount).length > 0) {
                            let annotationStatsHtml = '';
                            for (const [className, count] of Object.entries(data.annotationsCount)) {
                                annotationStatsHtml += `<li>${className}: <span class="annotation-count">${count}</span></li>`;
                            }
                            annotationStatsElement.innerHTML = annotationStatsHtml;
                        } else {
                            // If no annotations, show empty state
                            annotationStatsElement.innerHTML = '<li>No annotations yet</li>';
                        }

                        // Remove loading class from any annotation count elements
                        const annotationCountElements = annotationStatsElement.querySelectorAll('.annotation-count');
                        annotationCountElements.forEach(element => {
                            element.classList.remove('loading-count');
                        });
                    } else {
                        // If the annotation stats element doesn't exist, update the entire stats section
                        const statsElement = projectCard.querySelector('.project-stats');
                        if (statsElement) {
                            // Create updated stats HTML
                            let statsHtml = '';

                            // Always show Images count
                            statsHtml += `<div><strong>Images:</strong> <span class="image-count">${imageCount}</span></div>`;

                            // Add annotation counts per class if available
                            statsHtml += '<div><strong>Annotations:</strong></div>';
                            statsHtml += '<ul class="annotation-stats">';
                            if (Object.keys(data.annotationsCount).length > 0) {
                                for (const [className, count] of Object.entries(data.annotationsCount)) {
                                    statsHtml += `<li>${className}: <span class="annotation-count">${count}</span></li>`;
                                }
                            } else {
                                statsHtml += '<li>No annotations yet</li>';
                            }
                            statsHtml += '</ul>';

                            // Update the stats HTML
                            statsElement.innerHTML = statsHtml;

                            // Remove loading class from any count elements
                            const countElements = statsElement.querySelectorAll('.image-count, .annotation-count');
                            countElements.forEach(element => {
                                element.classList.remove('loading-count');
                            });
                        }
                    }
                }
            })
            .catch(error => {
                console.error(`Error updating project counts: ${error}`);

                // Implement retry with exponential backoff
                if (retryCount < maxRetries) {
                    retryCount++;
                    const nextBackoff = backoff * 2; // Exponential backoff
                    console.log(`Retrying fetch counts in ${backoff}ms (attempt ${retryCount}/${maxRetries})...`);
                    setTimeout(() => fetchCountsWithRetry(nextBackoff), backoff);
                } else {
                    console.error(`Failed to update project counts after ${maxRetries} attempts`);

                    // If we can't get the counts from the server, use the local counts as a fallback
                    if (isCurrentlyUploading) {
                        const imageCountElement = projectCard.querySelector('.image-count');
                        if (imageCountElement) {
                            imageCountElement.textContent = projectCompletedUploads[projectId] || 0;
                            imageCountElement.classList.remove('loading-count');
                        }
                    }
                }
            });
    }

    // Start the fetch with initial backoff
    fetchCountsWithRetry(initialBackoff);
}

// Function to save project settings
function saveProjectSettings() {
    // Get project ID from data attribute
    const projectId = document.getElementById('saveProjectSettingsBtn').dataset.projectId;

    if (!projectId) {
        alert('Project ID not found');
        return;
    }

    // Get project name
    const projectName = document.getElementById('settingsProjectName').value.trim();

    if (!projectName) {
        alert('Please enter a project name');
        return;
    }

    // Get classes and colors
    const classItems = document.querySelectorAll('.class-item');
    const classes = [];
    const classColors = {};

    classItems.forEach((item, index) => {
        const className = item.querySelector('.class-name').value.trim();
        const color = item.querySelector('.class-color').value;

        if (className) {
            classes.push(className);
            classColors[index] = color;
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
            classColors: classColors
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to update project settings');
        }
        return response.json();
    })
    .then(data => {
        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('projectSettingsModal'));
        modal.hide();

        // Show success message
        alert('Project settings saved successfully');

        // Reload projects to reflect changes
        loadProjects();
    })
    .catch(error => {
        console.error('Error saving project settings:', error);
        alert('Failed to save project settings. Please try again.');
    });
}
