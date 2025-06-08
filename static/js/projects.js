document.addEventListener('DOMContentLoaded', function() {
    // Load projects when the page loads
    loadProjects();

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
});

// Function to load projects
function loadProjects() {
    fetch('/projects')
        .then(response => response.json())
        .then(projects => {
            const projectsList = document.getElementById('projectsList');
            const noProjectsMessage = document.getElementById('noProjectsMessage');

            // Clear existing projects
            projectsList.innerHTML = '';

            if (projects.length === 0) {
                noProjectsMessage.style.display = 'block';
            } else {
                noProjectsMessage.style.display = 'none';

                // Create a card for each project
                projects.forEach(project => {
                    const projectCard = createProjectCard(project);
                    projectsList.appendChild(projectCard);
                });
            }
        })
        .catch(error => {
            console.error('Error loading projects:', error);
            alert('Failed to load projects. Please try again.');
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
        statsHtml += `<div><strong>Images:</strong> ${project.imageCount}</div>`;
    }

    // Add annotation counts per class
    if (project.annotationsCount && Object.keys(project.annotationsCount).length > 0) {
        statsHtml += '<div><strong>Annotations:</strong></div>';
        statsHtml += '<ul class="annotation-stats">';
        for (const [className, count] of Object.entries(project.annotationsCount)) {
            statsHtml += `<li>${className}: ${count}</li>`;
        }
        statsHtml += '</ul>';
    }

    // Set classes and stats
    clone.querySelector('.project-classes').innerHTML = classesText;

    // Add stats element if it doesn't exist
    if (!clone.querySelector('.project-stats')) {
        const statsDiv = document.createElement('div');
        statsDiv.className = 'project-stats mt-2';
        clone.querySelector('.card-body').insertBefore(statsDiv, clone.querySelector('.d-flex'));
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
        classes: classes
    };

    // Send request to create project
    fetch('/projects', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(projectData)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to create project');
        }
        return response.json();
    })
    .then(data => {
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

        // Reload projects
        loadProjects();
    })
    .catch(error => {
        console.error('Error creating project:', error);
        alert('Failed to create project. Please try again.');
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
